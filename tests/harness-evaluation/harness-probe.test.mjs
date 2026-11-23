// harness-probe tests — TDD acceptance for issue #7 harness evaluation.
// Run: node --test tests/harness-evaluation/harness-probe.test.mjs
//
// These assertions are deliberately offline: they read the recorded harness
// surfaces in ./fixtures and never call a provider. That is the point of the
// capability axis — it can be established without spending allowance, while
// the cost axis cannot be established in a sandbox with no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  APPROVAL_SURFACES,
  CANDIDATES,
  capabilityRows,
  costFinding,
  readCodexMethods,
  readClaudeHelp,
  readClaudeLifecycle,
  reduceSchemaBundle,
} from '../../tools/harness-probe.mjs';

const FIXTURES = new URL('./fixtures/', import.meta.url);

function fixture(name) {
  return fileURLToPath(new URL(name, FIXTURES));
}

function claudeLifecycle() {
  return readClaudeLifecycle({
    stopHelp: readFileSync(fixture('claude-code-stop-help.txt'), 'utf8'),
    attachHelp: readFileSync(fixture('claude-code-attach-help.txt'), 'utf8'),
  });
}

test('CAP-001: Claude Code structured surface advertises the control flags we need', () => {
  const help = readClaudeHelp(readFileSync(fixture('claude-code-help.txt'), 'utf8'));
  // Every control on the capability axis must have a documented flag.
  for (const flag of [
    '--print',
    '--output-format',
    '--input-format',
    '--resume',
    '--session-id',
    '--permission-mode',
    '--include-partial-messages',
  ]) {
    assert.ok(help.flags.has(flag), `missing ${flag}`);
  }
  // stream-json is the structured channel, for both directions.
  assert.ok(help.values.has('stream-json'), 'stream-json not offered');
  assert.deepEqual(help.permissionModes.sort(), [
    'acceptEdits',
    'auto',
    'bypassPermissions',
    'dontAsk',
    'manual',
    'plan',
  ]);
});

test('CAP-002: Codex app-server exposes start/observe/approve/interrupt/resume', () => {
  const methods = readCodexMethods(
    JSON.parse(readFileSync(fixture('codex-app-server-methods.json'), 'utf8')),
  );
  // Start work.
  assert.ok(methods.client.has('thread/start'));
  assert.ok(methods.client.has('turn/start'));
  // Inspect tool activity.
  assert.ok(methods.notification.has('item/started'));
  assert.ok(methods.notification.has('item/completed'));
  assert.ok(methods.notification.has('item/commandExecution/outputDelta'));
  // Handle questions and permissions.
  assert.ok(methods.request.has('item/tool/requestUserInput'));
  assert.ok(methods.request.has('item/commandExecution/requestApproval'));
  assert.ok(methods.request.has('item/fileChange/requestApproval'));
  // Interrupt and reconnect.
  assert.ok(methods.client.has('turn/interrupt'));
  assert.ok(methods.client.has('thread/resume'));
  // Show resulting changes.
  assert.ok(methods.notification.has('turn/diff/updated'));
  // Cost observability: token usage is reported, not merely billed.
  assert.ok(methods.notification.has('thread/tokenUsage/updated'));
});

test('CAP-003: codex exec covers the bounded task but not live approval/interrupt', () => {
  const help = readClaudeHelp(readFileSync(fixture('codex-exec-help.txt'), 'utf8'));
  // Non-interactive JSONL streaming exists.
  assert.ok(help.flags.has('--json'));
  assert.ok(help.flags.has('--output-schema'));
  assert.ok(help.flags.has('--sandbox'));
  assert.ok(help.flags.has('--cd'));
  // ...but the exec subcommand offers no resume, no interrupt, and no live
  // approval round-trip: only a blanket bypass.
  assert.equal(help.flags.has('--resume'), false);
  assert.equal(help.flags.has('--permission-prompt-tool'), false);
});

test('CAP-004: capability matrix is derived from evidence, not asserted by hand', () => {
  const rows = capabilityRows({
    claudeHelp: readClaudeHelp(readFileSync(fixture('claude-code-help.txt'), 'utf8')),
    codexMethods: readCodexMethods(
      JSON.parse(readFileSync(fixture('codex-app-server-methods.json'), 'utf8')),
    ),
    claudeLifecycle: claudeLifecycle(),
  });
  const byControl = (id) => rows.find((r) => r.control === id);
  for (const control of Object.keys(APPROVAL_SURFACES)) {
    assert.ok(byControl(control), `no row for ${control}`);
  }
  // Claude Code cannot handle an interactive permission prompt in --print mode
  // unless a host answers it; the app-server can.
  assert.equal(byControl('approve-permission').claudeCode, 'host-dependent');
  assert.equal(byControl('approve-permission').codexAppServer, 'yes');
  // Both advertise interrupt, but only one of them does it in exec mode.
  assert.equal(byControl('interrupt').claudeCode, 'yes');
  assert.equal(byControl('interrupt').codexAppServer, 'yes');
  assert.equal(byControl('interrupt').codexExec, 'no');
  // Reconnect is a property of the structured surfaces only.
  assert.equal(byControl('reconnect').codexExec, 'no');
  assert.equal(byControl('reconnect').claudeCode, 'yes');
});

test('CAP-005: candidates are exactly the three the issue bounds', () => {
  assert.deepEqual(
    CANDIDATES.map((c) => c.id),
    ['claude-cli-baseline', 'claude-cli-stream-json', 'codex-app-server'],
  );
  for (const candidate of CANDIDATES) {
    assert.equal(typeof candidate.project, 'string');
    assert.ok(candidate.project.length > 0, `${candidate.id} has no project`);
    assert.equal(typeof candidate.unmodified, 'boolean');
  }
  // An execution-service candidate is explicitly out of scope for this POC.
  assert.equal(CANDIDATES.some((c) => c.id === 't3-code'), false);
});

test('COST-001: cost findings separate measured from unmeasured', () => {
  const finding = costFinding({
    providerReachable: false,
    authenticated: false,
    tokenUsageExposed: true,
  });
  // Nothing can be claimed as measured without a reachable, authenticated run.
  assert.equal(finding.measured.length, 0);
  assert.match(finding.verdict, /not measured|unmeasured/i);
  // The mechanism is recorded even though the number is not.
  assert.equal(finding.mechanism.tokenUsageExposed, true);
  assert.ok(finding.unmeasured.some((u) => /network/i.test(u)));
  assert.ok(finding.unmeasured.some((u) => /logged in|auth/i.test(u)));
});

test('CAP-006: interrupt and reconnect come from recorded commands, not inference', () => {
  const lifecycle = claudeLifecycle();
  // `claude stop <id>` is the measured interrupt; it is not in `--help`, which
  // is why it had to be recorded separately.
  assert.equal(lifecycle.stop, true);
  // `claude attach <id>` is the measured reconnect, and `stop --help` says the
  // conversation is kept for it.
  assert.equal(lifecycle.attach, true);
  assert.equal(lifecycle.keepsConversation, true);

  const rows = capabilityRows({
    claudeHelp: readClaudeHelp(readFileSync(fixture('claude-code-help.txt'), 'utf8')),
    codexMethods: readCodexMethods(
      JSON.parse(readFileSync(fixture('codex-app-server-methods.json'), 'utf8')),
    ),
    claudeLifecycle: lifecycle,
  });
  const byControl = (id) => rows.find((r) => r.control === id);
  assert.match(byControl('interrupt').evidence.claudeCode, /claude stop/);
  assert.match(byControl('reconnect').evidence.claudeCode, /claude attach/);
});

test('CAP-007: the methods fixture is reproducible from a schema bundle', () => {
  // `generate-json-schema` emits one file per type, each a draft-07 `oneOf` of
  // request/notification objects whose `method` property is a single-value
  // enum. This is the recorded reduction; without it the fixture cannot be
  // regenerated, only trusted.
  const bundle = {
    ClientRequest: {
      oneOf: [
        { properties: { method: { enum: ['initialize'] } } },
        { properties: { method: { enum: ['thread/start'] } } },
      ],
    },
    ServerNotification: {
      oneOf: [{ properties: { method: { enum: ['item/started'] } } }],
    },
    ServerRequest: { oneOf: [] },
  };
  assert.deepEqual(reduceSchemaBundle(bundle), {
    ClientRequest: ['initialize', 'thread/start'],
    ServerNotification: ['item/started'],
    ServerRequest: [],
  });

  // And it reproduces the committed fixture from the committed schema types.
  const schemaDir = fixture('codex-app-server');
  const read = (name) => JSON.parse(readFileSync(`${schemaDir}/${name}.json`, 'utf8'));
  const reduced = reduceSchemaBundle({
    ClientRequest: read('ClientRequest'),
    ServerNotification: read('ServerNotification'),
    ServerRequest: read('ServerRequest'),
  });
  assert.deepEqual(
    reduced,
    JSON.parse(readFileSync(fixture('codex-app-server-methods.json'), 'utf8')),
  );
});
