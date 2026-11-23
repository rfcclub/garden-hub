// ghub-service tests - `print` only. They never touch launchd and never write a
// file: the script renders the plist from the template and exits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, 'service', 'ghub-service.sh');
const REPO = dirname(__dirname);
const LABEL = 'com.anima.garden-hub-dashboard';
const DEFAULT_PORT = '47820';

function runPrint({ env = {}, command = 'print' } = {}) {
  return spawnSync('/bin/bash', [SCRIPT, command], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

function printPlist(env) {
  const result = runPrint({ env });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '', 'print must not write to stderr');
  return result.stdout;
}

test('SVC-001: print emits a well-formed plist with the required keys', () => {
  const plist = printPlist();

  // Shape: the XML declaration, the property-list doctype, one top-level dict.
  assert.match(plist, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n/);
  assert.match(plist, /<!DOCTYPE plist PUBLIC "-\/\/Apple\/\/DTD PLIST 1\.0\/\/EN" "http:\/\/www\.apple\.com\/DTDs\/PropertyList-1\.0\.dtd">/);
  assert.ok(plist.includes('<plist version="1.0">'));
  assert.ok(plist.includes('<dict>') && plist.includes('</dict>'));
  assert.ok(plist.trimEnd().endsWith('</plist>'));

  for (const key of [
    'Label',
    'ProgramArguments',
    'RunAtLoad',
    'KeepAlive',
    'ThrottleInterval',
    'StandardOutPath',
    'StandardErrorPath',
  ]) {
    assert.ok(plist.includes(`<key>${key}</key>`), `missing key ${key}`);
  }

  assert.ok(plist.includes(`<string>${LABEL}</string>`), 'label is missing');
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>ThrottleInterval<\/key>\s*<integer>30<\/integer>/);
});

test('SVC-002: print uses absolute node and repository paths, not a PATH lookup', () => {
  const plist = printPlist();

  const node = printPlist();
  assert.ok(node.includes('<string>/'), 'program arguments must be absolute');

  // Every string inside ProgramArguments is an absolute path or a flag.
  const args = [...plist.split('<key>ProgramArguments</key>')[1].split('</array>')[0].matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);
  assert.ok(args.length >= 2, 'expected node plus the dashboard entry point');
  for (const arg of args) {
    assert.ok(arg.startsWith('/'), `program argument is not absolute: ${arg}`);
  }

  assert.ok(args[1].endsWith('/tools/ghub-dashboard.mjs'), `unexpected entry point: ${args[1]}`);
  assert.equal(dirname(dirname(args[1])), REPO, 'entry point must live in this checkout');

  // No bare command name and no shell PATH assignment anywhere in the plist.
  assert.ok(!plist.includes('<key>PATH</key>'), 'the agent must not depend on a PATH');
  assert.ok(!/<\/string>\s*node\s*<\/string>/.test(plist), 'node must be absolute');
});

test('SVC-003: print binds only the dashboard port from GHUB_DASHBOARD_PORT', () => {
  const fallback = printPlist();
  assert.match(
    fallback,
    new RegExp(`<key>GHUB_DASHBOARD_PORT</key>\\s*<string>${DEFAULT_PORT}</string>`),
    'the dashboard default port must be filled in',
  );

  const overridden = printPlist({ GHUB_DASHBOARD_PORT: '51234' });
  assert.match(overridden, /<key>GHUB_DASHBOARD_PORT<\/key>\s*<string>51234<\/string>/);
  assert.ok(!overridden.includes(DEFAULT_PORT), 'an explicit port must replace the default');

  // The only port-looking value in the plist is the dashboard port.
  const ports = [...new Set(overridden.match(/(?:^|[:=])([0-9]{4,5})(?=$|\D)/gm) ?? [])];
  assert.ok(overridden.includes('<string>51234</string>'));

  // Loopback only: nothing asks the dashboard to listen elsewhere.
  assert.ok(!/GHUB_DASHBOARD_HOST|GHUB_DASHBOARD_BIND|0\.0\.0\.0/.test(overridden));
  assert.equal(ports.length <= 1, true, `unexpected extra port values: ${ports.join(',')}`);
});

test('SVC-004: print sets the event directory and leaves the work database unset', () => {
  const plist = printPlist();

  const events = plist.match(/<key>GHUB_EVENTS_DIR<\/key>\s*<string>([^<]*)<\/string>/);
  assert.ok(events, 'GHUB_EVENTS_DIR is missing');
  assert.equal(events[1], join(REPO, 'events'));

  // No database path: the dashboard resolves GHUB_WORK_DB itself.
  assert.ok(!plist.includes('GHUB_WORK_DB'), 'GHUB_WORK_DB must stay unset');
});

test('SVC-005: print writes a log under ~/Library/Logs/anima and no secret', () => {
  const plist = printPlist();
  const log = `${process.env.HOME}/Library/Logs/anima/garden-hub-dashboard.log`;

  assert.match(plist, new RegExp(`<key>StandardOutPath</key>\\s*<string>${log.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</string>`));
  assert.match(plist, new RegExp(`<key>StandardErrorPath</key>\\s*<string>${log.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</string>`));

  for (const needle of ['GHUB_TOKEN', 'GITHUB_TOKEN', 'SECRET', 'PASSWORD', 'API_KEY']) {
    assert.ok(!plist.toUpperCase().includes(needle), `plist must not mention ${needle}`);
  }
});

test('SVC-006: print fails with a clear message when node cannot be resolved', () => {
  const result = runPrint({ env: { PATH: '' } });

  assert.notEqual(result.status, 0, 'an empty PATH must not produce a plist');
  assert.equal(result.stdout, '', 'nothing may be printed on failure');
  assert.match(result.stderr, /node/i);
  assert.match(result.stderr, /PATH/);
});
