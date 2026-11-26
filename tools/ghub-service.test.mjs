// ghub-service tests use temporary homes and a fake launchctl for install.
// No test installs, unloads, or otherwise contacts a real launchd service.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, 'service', 'ghub-service.sh');
const REPO = dirname(__dirname);
const LABEL = 'com.anima.garden-hub-dashboard';
const DEFAULT_PORT = '47820';

function runPrint({ env = {}, command = 'print' } = {}) {
  const childEnv = { ...process.env };
  delete childEnv.GHUB_DASHBOARD_PORT;
  return spawnSync('/bin/bash', [SCRIPT, command], {
    env: { ...childEnv, ...env },
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
  const stringPorts = [...overridden.matchAll(/<string>\s*([0-9]{1,5})\s*<\/string>/g)].map((match) => match[1]);
  const embeddedPorts = [...overridden.matchAll(/[:=]([0-9]{1,5})(?=\D|$)/g)].map((match) => match[1]);
  const ports = [...new Set([...stringPorts, ...embeddedPorts])];

  // Loopback only: nothing asks the dashboard to listen elsewhere.
  assert.ok(!/GHUB_DASHBOARD_HOST|GHUB_DASHBOARD_BIND|0\.0\.0\.0/.test(overridden));
  assert.deepEqual(ports, ['51234'], `unexpected extra port values: ${ports.join(',')}`);
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

test('SVC-007: print fails closed when HOME is not set', () => {
  const env = { ...process.env };
  delete env.HOME;
  const result = spawnSync('/bin/bash', [SCRIPT, 'print'], { env, encoding: 'utf8' });

  assert.notEqual(result.status, 0, 'a missing HOME must not produce a plist');
  assert.equal(result.stdout, '', 'nothing may be printed on failure');
  assert.match(result.stderr, /HOME/);
});

test('SVC-008: print keeps sed metacharacters in the checkout path literal', () => {
  // Render the service from a copy living in a directory whose name contains
  // `&` and `|`, both special to a sed substitution. The plist is XML, so `&`
  // arrives as the `&amp;` entity, which plist readers decode back to `&`.
  const parent = mkdtempSync(join(tmpdir(), 'ghub-service-'));
  try {
    const repo = join(parent, 'gh amp&pipe|checkout<xml>');
    cpSync(join(__dirname, 'service'), join(repo, 'tools', 'service'), { recursive: true });
    const script = join(repo, 'tools', 'service', 'ghub-service.sh');

    const result = spawnSync('/bin/bash', [script, 'print'], {
      env: { ...process.env },
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.ok(!result.stdout.includes('@'), 'placeholders must all be filled in');

    const xml = (value) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    assert.ok(
      result.stdout.includes(`<string>${xml(repo)}/tools/ghub-dashboard.mjs</string>`),
      'the entry point must resolve inside the checkout, not keep the placeholder',
    );
    assert.ok(result.stdout.includes(`<string>${xml(repo)}/events</string>`));
    assert.ok(result.stdout.includes(`<string>${xml(repo)}</string>`));
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('SVC-009: install, uninstall and status fail closed when HOME is not set', () => {
  for (const command of ['install', 'uninstall', 'status']) {
    const env = { ...process.env };
    delete env.HOME;
    const result = spawnSync('/bin/bash', [SCRIPT, command], { env, encoding: 'utf8' });

    assert.notEqual(result.status, 0, `${command} must not run without a home directory`);
    assert.equal(result.stdout, '', `${command} must print nothing on failure`);
    assert.match(result.stderr, /HOME/, `${command} must say why it refused`);
  }
});

test('SVC-010: status probes the port recorded in the installed plist', () => {
  // A temp HOME with a plist for a non-default port. `status` reads that file
  // and prints the URL it probed; it never writes and never loads anything.
  const home = mkdtempSync(join(tmpdir(), 'ghub-service-home-'));
  try {
    mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true });
    writeFileSync(
      join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`),
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<plist version="1.0">',
        '<dict>',
        '  <key>EnvironmentVariables</key>',
        '  <dict>',
        '    <key>GHUB_DASHBOARD_PORT</key>',
        '    <string>51234</string>',
        '  </dict>',
        '</dict>',
        '</plist>',
        '',
      ].join('\n'),
    );

    const result = spawnSync('/bin/bash', [SCRIPT, 'status'], {
      env: { ...process.env, HOME: home, GHUB_DASHBOARD_PORT: '47821' },
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /127\.0\.0\.1:51234\//, 'status must use the installed port');
    assert.ok(
      !result.stdout.includes(':47821') && !result.stdout.includes(':47820'),
      'status must use neither the ambient nor the default port',
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// These tests use a copied script, a fake HOME and a fake launchctl. The
// dashboard stub only satisfies the entry-point check; it is never executed.
function makeInstallFixture({ race = false, raceLink = 'symbolic', extraEnv = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ghub-service-test-'));
  const home = join(root, 'home');
  const repoTools = join(root, 'repo', 'tools');
  const bin = join(root, 'bin');
  const agentDir = join(home, 'Library', 'LaunchAgents');
  const agent = join(agentDir, `${LABEL}.plist`);
  const log = join(root, 'launchctl.log');
  const marker = join(root, 'race-marker');
  const victim = join(root, 'victim');
  mkdirSync(repoTools, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(bin, { recursive: true });
  cpSync(join(__dirname, 'service'), join(repoTools, 'service'), { recursive: true });
  writeFileSync(join(repoTools, 'ghub-dashboard.mjs'), '// test stub\n');
  const launchctl = join(bin, 'launchctl');
  writeFileSync(launchctl, '#!/bin/bash\nprintf "%s\\n" "$*" >> "$GHUB_TEST_LAUNCHCTL_LOG"\n');
  chmodSync(launchctl, 0o755);
  if (race) {
    const node = join(bin, 'node');
    writeFileSync(node, [
      '#!/bin/bash',
      'if [ "${1:-}" = "-e" ]; then',
      raceLink === 'hard'
        ? '  ln "$GHUB_TEST_VICTIM" "$GHUB_TEST_AGENT"'
        : '  ln -s "$GHUB_TEST_VICTIM" "$GHUB_TEST_AGENT"',
      '  printf "injected\\n" > "$GHUB_TEST_RACE_MARKER"',
      'fi',
      'exec "$GHUB_TEST_REAL_NODE" "$@"',
      '',
    ].join('\n'));
    chmodSync(node, 0o755);
  }
  const env = {
    ...process.env,
    HOME: home,
    PATH: `${bin}${delimiter}${process.env.PATH || ''}`,
    GHUB_DASHBOARD_PORT: DEFAULT_PORT,
    GHUB_TEST_LAUNCHCTL_LOG: log,
    GHUB_TEST_AGENT: agent,
    GHUB_TEST_VICTIM: victim,
    GHUB_TEST_RACE_MARKER: marker,
    GHUB_TEST_REAL_NODE: process.execPath,
    ...extraEnv,
  };
  return {
    root, agent, log, marker, victim,
    install: (...args) => spawnSync('/bin/bash', [join(repoTools, 'service', 'ghub-service.sh'), 'install', ...args], { env, encoding: 'utf8' }),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

for (const kind of ['file', 'directory', 'dangling']) {
  for (const force of [false, true]) {
    test(`SVC-SYMLINK-1: refuse ${kind} link${force ? ' with --force' : ''}`, () => {
      const f = makeInstallFixture();
      try {
        if (kind === 'file') {
          writeFileSync(f.victim, 'victim must remain unchanged\n');
          chmodSync(f.victim, 0o600);
        } else if (kind === 'directory') {
          mkdirSync(f.victim);
          writeFileSync(join(f.victim, 'keep'), 'directory remains unchanged\n');
        }
        symlinkSync(f.victim, f.agent, kind === 'directory' ? 'dir' : 'file');
        const result = f.install(...(force ? ['--force'] : []));
        if (kind === 'file') {
          assert.equal(readFileSync(f.victim, 'utf8'), 'victim must remain unchanged\n', 'install must not overwrite the linked file');
          assert.equal(statSync(f.victim).mode & 0o777, 0o600, 'install must not chmod the linked file');
        } else if (kind === 'directory') {
          assert.equal(readFileSync(join(f.victim, 'keep'), 'utf8'), 'directory remains unchanged\n');
        } else {
          assert.equal(existsSync(f.victim), false, 'install must not create a dangling link target');
        }
        assert.notEqual(result.status, 0, 'installation must fail on a link');
        assert.ok(lstatSync(f.agent).isSymbolicLink());
        assert.equal(readlinkSync(f.agent), f.victim);
        assert.equal(existsSync(f.log), false, 'must not call launchctl');
      } finally {
        f.cleanup();
      }
    });
  }
}

test('SVC-SYMLINK-2: refuse a link inserted between the check and open', () => {
  const f = makeInstallFixture({ race: true });
  try {
    writeFileSync(f.victim, 'race victim remains unchanged\n');
    chmodSync(f.victim, 0o600);
    const result = f.install();
    assert.ok(existsSync(f.marker), 'the fake Node wrapper must inject the race');
    assert.notEqual(result.status, 0, 'a substituted link must fail closed');
    assert.ok(lstatSync(f.agent).isSymbolicLink());
    assert.equal(readFileSync(f.victim, 'utf8'), 'race victim remains unchanged\n');
    assert.equal(statSync(f.victim).mode & 0o777, 0o600);
    assert.equal(existsSync(f.log), false, 'must not call launchctl after a failed open');
  } finally {
    f.cleanup();
  }
});

test('SVC-SYMLINK-3: normal and forced regular installs retain their behavior', () => {
  const f = makeInstallFixture();
  try {
    let result = f.install();
    assert.equal(result.status, 0, result.stderr);
    assert.ok(lstatSync(f.agent).isFile());
    assert.equal(statSync(f.agent).mode & 0o777, 0o644);
    assert.match(readFileSync(f.agent, 'utf8'), /<plist version="1\.0">/);
    assert.equal(readFileSync(f.log, 'utf8').split('\n').filter(line => line.startsWith('bootstrap ')).length, 1);
    writeFileSync(f.agent, 'different regular plist\n');
    result = f.install();
    assert.notEqual(result.status, 0, 'a different regular plist requires --force');
    assert.equal(readFileSync(f.agent, 'utf8'), 'different regular plist\n');
    result = f.install('--force');
    assert.equal(result.status, 0, result.stderr);
    assert.ok(lstatSync(f.agent).isFile());
    assert.equal(statSync(f.agent).mode & 0o777, 0o644);
    assert.match(readFileSync(f.agent, 'utf8'), /<plist version="1\.0">/);
    assert.equal(readFileSync(f.log, 'utf8').split('\n').filter(line => line.startsWith('bootstrap ')).length, 2);
  } finally {
    f.cleanup();
  }
});

// `die` inside a command substitution exits only the subshell, so an invalid
// GHUB_DASHBOARD_PORT killed `resolve_port` while `render` went on with an
// empty port and `install` loaded a plist that bound nothing.
for (const port of ['5123O', '99999', '0', '-1', 'abc']) {
  test(`SVC-PORT-1: install refuses GHUB_DASHBOARD_PORT=[${port}]`, () => {
    const f = makeInstallFixture({ extraEnv: { GHUB_DASHBOARD_PORT: port } });
    try {
      const result = f.install();
      assert.notEqual(result.status, 0, `install must fail for port=[${port}]`);
      assert.match(result.stderr, /GHUB_DASHBOARD_PORT/, 'install must say why it refused');
      assert.equal(existsSync(f.agent), false, 'no plist may be written');
      assert.equal(existsSync(f.log), false, 'launchctl must not be called');
    } finally {
      f.cleanup();
    }
  });
}

test('SVC-PORT-2: --force must not replace an operator plist when the port is invalid', () => {
  const f = makeInstallFixture({ extraEnv: { GHUB_DASHBOARD_PORT: '5123O' } });
  try {
    writeFileSync(f.agent, 'operator plist, hand-edited\n');
    chmodSync(f.agent, 0o600);
    const result = f.install('--force');
    assert.notEqual(result.status, 0, 'a failed render must abort before the write');
    assert.equal(readFileSync(f.agent, 'utf8'), 'operator plist, hand-edited\n');
    assert.equal(statSync(f.agent).mode & 0o777, 0o600, 'mode must be preserved');
    assert.equal(existsSync(f.log), false, 'launchctl must not be called');
  } finally {
    f.cleanup();
  }
});

// A PATH holding exactly the utilities `install` invokes and no node. The
// earlier fixture spelled `"${bin}:/usr/bin:/bin"` to mean "node is absent",
// which is false on any host that ships node under a system path: install then
// found node and succeeded, and the test failed on valid product behaviour
// rather than on the absence it meant to create. The tools are symlinked from
// the host so the premise holds wherever the suite runs.
const INSTALL_PATH_TOOLS = ['awk', 'cat', 'grep', 'id', 'mkdir'];

function systemToolsPath(root) {
  const dir = join(root, 'system-tools');
  mkdirSync(dir, { recursive: true });
  for (const tool of INSTALL_PATH_TOOLS) {
    const found = (process.env.PATH || '')
      .split(delimiter)
      .filter(Boolean)
      .map((candidate) => join(candidate, tool))
      .find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
    assert.ok(found, `cannot locate ${tool} to build the isolated PATH`);
    symlinkSync(found, join(dir, tool));
  }
  // Prove the absence instead of assuming it: a host that exposes node through
  // one of these directories would otherwise weaken the test silently.
  const probe = spawnSync('/bin/bash', ['-c', 'command -v node'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${dir}${delimiter}${join(root, 'bin')}` },
  });
  assert.notEqual(probe.status, 0, `the isolated PATH must not expose node: ${probe.stdout.trim()}`);
  return dir;
}

test('SVC-PORT-3: a missing node leaves no ~/Library behind', () => {
  // No fixture directory: the point is that install aborts before mkdir -p.
  const root = mkdtempSync(join(tmpdir(), 'ghub-service-node-'));
  try {
    const home = join(root, 'home');
    const bin = join(root, 'bin');
    const tools = join(root, 'repo', 'tools');
    mkdirSync(home, { recursive: true });
    mkdirSync(bin, { recursive: true });
    mkdirSync(tools, { recursive: true });
    cpSync(join(__dirname, 'service'), join(tools, 'service'), { recursive: true });
    writeFileSync(join(tools, 'ghub-dashboard.mjs'), '// test stub\n');
    writeFileSync(join(bin, 'launchctl'), '#!/bin/bash\nprintf "%s\\n" "$*" >> "$GHUB_TEST_LAUNCHCTL_LOG"\n');
    chmodSync(join(bin, 'launchctl'), 0o755);
    const systemTools = systemToolsPath(root);

    const result = spawnSync('/bin/bash', [join(tools, 'service', 'ghub-service.sh'), 'install'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        PATH: `${bin}${delimiter}${systemTools}`,
        GHUB_TEST_LAUNCHCTL_LOG: join(root, 'launchctl.log'),
      },
    });

    assert.notEqual(result.status, 0, 'install must fail without node');
    assert.match(result.stderr, /node/i);
    assert.equal(existsSync(join(home, 'Library', 'LaunchAgents')), false, 'no LaunchAgents directory may be created');
    assert.equal(existsSync(join(root, 'launchctl.log')), false, 'launchctl must not be called');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


// A hard link at the destination shares its inode with another file, so
// O_NOFOLLOW does not stop a forced install from rewriting that file and
// forcing its mode to 0644. Refuse any destination with more than one link,
// whether it was there before the install or appeared after the pre-check.
for (const force of [false, true]) {
  test(`SVC-HARDLINK-1: refuse a hard-linked destination${force ? ' with --force' : ''}`, () => {
    const f = makeInstallFixture();
    try {
      writeFileSync(f.victim, 'unrelated file\n');
      chmodSync(f.victim, 0o600);
      linkSync(f.victim, f.agent);
      const result = force ? f.install('--force') : f.install();
      assert.notEqual(result.status, 0, 'install must refuse a hard-linked destination');
      assert.equal(readFileSync(f.victim, 'utf8'), 'unrelated file\n', 'the linked file must keep its contents');
      assert.equal(statSync(f.victim).mode & 0o777, 0o600, 'the linked file must keep its mode');
      assert.equal(existsSync(f.log), false, 'launchctl must not be called');
    } finally {
      f.cleanup();
    }
  });
}

test('SVC-HARDLINK-2: refuse a hard link inserted between the check and open', () => {
  const f = makeInstallFixture({ race: true, raceLink: 'hard' });
  try {
    writeFileSync(f.victim, 'unrelated file\n');
    chmodSync(f.victim, 0o600);
    const result = f.install();
    assert.equal(readFileSync(f.marker, 'utf8'), 'injected\n', 'the race hook must have run');
    assert.notEqual(result.status, 0, 'install must refuse the inserted hard link');
    assert.equal(readFileSync(f.victim, 'utf8'), 'unrelated file\n', 'the linked file must keep its contents');
    assert.equal(statSync(f.victim).mode & 0o777, 0o600, 'the linked file must keep its mode');
    assert.equal(existsSync(f.log), false, 'launchctl must not be called');
  } finally {
    f.cleanup();
  }
});

// The dashboard parses 09123 as 9123 while status probed 127.0.0.1:09123, so
// the two disagreed about the port. A port is written without leading zeros.
for (const port of ['09123', '00080', '065535']) {
  test(`SVC-PORT-4: print and install refuse a leading-zero port [${port}]`, () => {
    const printed = runPrint({ env: { GHUB_DASHBOARD_PORT: port } });
    assert.notEqual(printed.status, 0, `print must fail for port=[${port}]`);
    assert.match(printed.stderr, /GHUB_DASHBOARD_PORT/);
    const f = makeInstallFixture({ extraEnv: { GHUB_DASHBOARD_PORT: port } });
    try {
      const result = f.install();
      assert.notEqual(result.status, 0, `install must fail for port=[${port}]`);
      assert.match(result.stderr, /GHUB_DASHBOARD_PORT/);
      assert.equal(existsSync(f.agent), false, 'no plist may be written');
      assert.equal(existsSync(f.log), false, 'launchctl must not be called');
    } finally {
      f.cleanup();
    }
  });
}
