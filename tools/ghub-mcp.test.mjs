import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createStore } from './ghub-mcp-store.mjs';
import {
  evaluateMergeEligibility,
  parsePullRequestUrl,
  pollWatch,
  submitReview,
  mergePullRequest,
} from './ghub-mcp-github.mjs';
import { createMcpServer } from './ghub-mcp-server.mjs';

const SERVER = fileURLToPath(new URL('./ghub-mcp-server.mjs', import.meta.url));
const README = fileURLToPath(new URL('../README.md', import.meta.url));

function stateRoot() {
  return mkdtempSync(join(tmpdir(), 'garden-hub-mcp-'));
}

function store(root, actor) {
  return createStore({
    root,
    actor,
    peers: ['codex', 'claude-code'],
    now: () => new Date('2026-10-13T12:00:00.000Z'),
  });
}

test('MSG-001: a durable Codex message reaches Claude Code after it was offline', () => {
  const root = stateRoot();
  const peerA = store(root, 'codex');

  const sent = peerA.sendMessage({
    to: 'claude-code',
    body: 'Please review https://github.com/example-org/garden-hub/pull/7',
    from: 'claude-code',
  });

  assert.equal(sent.from, 'codex', 'configured actor must override a forged from');
  const claude = store(root, 'claude-code');
  assert.deepEqual(claude.inbox(), [sent]);
});

test('MSG-002: only the recipient can acknowledge a message', () => {
  const root = stateRoot();
  const peerA = store(root, 'codex');
  const sent = peerA.sendMessage({ to: 'claude-code', body: 'hello' });

  assert.throws(() => peerA.ackMessage({ messageId: sent.id }), /recipient/i);
  assert.deepEqual(store(root, 'claude-code').inbox(), [sent]);

  store(root, 'claude-code').ackMessage({ messageId: sent.id });
  assert.deepEqual(store(root, 'claude-code').inbox(), []);
});

test('MSG-003: a reply preserves the source message thread ID', () => {
  const root = stateRoot();
  const sent = store(root, 'codex').sendMessage({ to: 'claude-code', body: 'ready?' });

  const reply = store(root, 'claude-code').replyMessage({
    messageId: sent.id,
    body: 'ready',
  });

  assert.equal(reply.threadId, sent.threadId);
  assert.equal(reply.replyTo, sent.id);
  assert.deepEqual(store(root, 'codex').inbox(), [reply]);
});

test('MSG-004: message audit records an outcome but not message text', () => {
  const root = stateRoot();
  const peerA = store(root, 'codex');
  peerA.sendMessage({ to: 'claude-code', body: 'token=not-for-audit' });

  const auditPath = join(root, 'audit.jsonl');
  const lines = readFileSync(auditPath, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const audit = JSON.parse(lines[0]);
  assert.deepEqual(Object.keys(audit).sort(), ['action', 'actor', 'at', 'id', 'ok', 'target']);
  assert.equal(audit.actor, 'codex');
  assert.equal(audit.action, 'message_send');
  assert.equal(audit.target, 'claude-code');
  assert.doesNotMatch(readFileSync(auditPath, 'utf8'), /not-for-audit/);
});

test('MCP-002: a server actor outside the peer allowlist cannot create state', () => {
  const root = stateRoot();

  assert.throws(
    () => createStore({ root, actor: 'pretender', peers: ['codex', 'claude-code'] }),
    /not allowed/i,
  );
  assert.deepEqual(readdirSync(root), []);
});

function snapshot({
  head = 'head-a',
  base = 'base-a',
  author = 'coder',
  reviews = [],
  unresolvedThreads = 0,
} = {}) {
  return {
    repo: 'example-org/garden-hub',
    number: 7,
    url: 'https://github.com/example-org/garden-hub/pull/7',
    author,
    head,
    base,
    reviews,
    unresolvedThreads,
  };
}

test('PR-001: a new head makes an existing reviewer watch actionable again', () => {
  const root = stateRoot();
  const peerA = store(root, 'codex');
  const watch = {
    key: 'example-org/garden-hub#7:codex',
    repo: 'example-org/garden-hub',
    number: 7,
    mode: 'reviewer',
    actor: 'codex',
    lastHeadSha: 'head-a',
    approvedHeadSha: 'head-a',
    approvedBaseSha: 'base-a',
  };

  const result = pollWatch({ store: peerA, watch, snapshot: snapshot({ head: 'head-b' }) });

  assert.equal(result.state, 'needs_review');
  assert.equal(result.watch.approvedHeadSha, undefined);
  assert.equal(result.watch.approvedBaseSha, undefined);
});

test('PR-003: a GitHub login matching the author cannot submit a review', () => {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    if (args.join(' ') === 'api user --jq .login') return { stdout: 'coder\n' };
    throw new Error(`unexpected command: ${args.join(' ')}`);
  };

  assert.throws(
    () =>
      submitReview({
        run,
        pullRequest: snapshot({ author: 'coder' }),
        event: 'approve',
        body: 'looks good',
      }),
    /author/i,
  );
  assert.equal(calls.length, 1);
});

test('PR-004: an approval for an old head is rejected before merge', () => {
  const calls = [];
  const result = mergePullRequest({
    run: (args) => calls.push(args),
    watch: {
      approvedHeadSha: 'head-a',
      approvedBaseSha: 'base-a',
    },
    snapshot: snapshot({
      head: 'head-b',
      reviews: [{ user: { login: 'reviewer' }, state: 'APPROVED', commit_id: 'head-b', submitted_at: '2026-10-13T12:00:00Z' }],
    }),
  });

  assert.deepEqual(result, { ok: false, code: 'approval_stale' });
  assert.deepEqual(calls, []);
});

test('PR-005: a changed base invalidates an already observed approval', () => {
  const result = evaluateMergeEligibility({
    watch: { approvedHeadSha: 'head-a', approvedBaseSha: 'base-a' },
    snapshot: snapshot({
      base: 'base-b',
      reviews: [{ user: { login: 'reviewer' }, state: 'APPROVED', commit_id: 'head-a', submitted_at: '2026-10-13T12:00:00Z' }],
    }),
  });

  assert.deepEqual(result, { ok: false, code: 'base_stale' });
});

test('PR-006: eligible approval merges using the expected current head SHA', () => {
  const calls = [];
  const pr = snapshot({
    reviews: [{ user: { login: 'reviewer' }, state: 'APPROVED', commit_id: 'head-a', submitted_at: '2026-10-13T12:00:00Z' }],
  });

  const result = mergePullRequest({
    run: (args) => {
      calls.push(args);
      return { stdout: '' };
    },
    watch: { approvedHeadSha: 'head-a', approvedBaseSha: 'base-a' },
    snapshot: pr,
  });

  assert.deepEqual(result, { ok: true, head: 'head-a' });
  assert.deepEqual(calls, [[
    'pr',
    'merge',
    pr.url,
    '--repo',
    pr.repo,
    '--merge',
    '--match-head-commit',
    'head-a',
  ]]);
});

test('PR URL parsing accepts only canonical github pull request URLs', () => {
  assert.deepEqual(parsePullRequestUrl('https://github.com/example-org/garden-hub/pull/7'), {
    repo: 'example-org/garden-hub',
    number: 7,
    url: 'https://github.com/example-org/garden-hub/pull/7',
  });
  assert.throws(() => parsePullRequestUrl('https://example.com/example-org/garden-hub/pull/7'), /GitHub PR URL/i);
});

test('MCP-001: tool arguments cannot impersonate the server actor', () => {
  const root = stateRoot();
  const server = createMcpServer({ root, actor: 'codex', peers: ['codex', 'claude-code'] });

  const reply = server.handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'message_send',
      arguments: { to: 'claude-code', body: 'hello', from: 'claude-code' },
    },
  });

  assert.equal(reply.result.isError, undefined);
  const message = JSON.parse(reply.result.content[0].text);
  assert.equal(message.from, 'codex');
});

test('MCP tools complete initialize and discovery without non-protocol state', () => {
  const root = stateRoot();
  const server = createMcpServer({ root, actor: 'codex', peers: ['codex', 'claude-code'] });

  const initialized = server.handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
  });
  assert.equal(initialized.result.protocolVersion, '2025-11-25');
  assert.equal(initialized.result.serverInfo.name, 'garden-hub');

  const tools = server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  assert.deepEqual(
    tools.result.tools.map((tool) => tool.name),
    [
      'message_send',
      'message_inbox',
      'message_ack',
      'message_reply',
      'pr_watch',
      'pr_create',
      'pr_poll',
      'pr_review',
      'pr_merge',
    ],
  );
  assert.deepEqual(readdirSync(root), [], 'read-only protocol calls must not create state');
});

test('MCP-003: Codex and Claude Code servers exchange through a shared state root', () => {
  const root = stateRoot();
  const peers = ['codex', 'claude-code'];
  const peerA = createMcpServer({ root, actor: 'codex', peers });
  const claude = createMcpServer({ root, actor: 'claude-code', peers });

  peerA.handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'message_send', arguments: { to: 'claude-code', body: 'review PR 7' } },
  });
  const inbox = claude.handle({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'message_inbox', arguments: {} },
  });
  const [message] = JSON.parse(inbox.result.content[0].text);
  assert.equal(message.body, 'review PR 7');

  const acknowledgement = claude.handle({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'message_ack', arguments: { messageId: message.id } },
  });
  assert.deepEqual(JSON.parse(acknowledgement.result.content[0].text), {
    messageId: message.id,
    actor: 'claude-code',
    acknowledged: true,
  });
});

function runStdioClient(actor, root, requests) {
  const run = spawnSync(process.execPath, [SERVER], {
    input: `${requests.map((request) => JSON.stringify(request)).join('\n')}\n`,
    encoding: 'utf8',
    env: {
      ...process.env,
      GHUB_MCP_ACTOR: actor,
      GHUB_MCP_PEERS: 'codex,claude-code',
      GHUB_MCP_STATE_DIR: root,
    },
  });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

test('MCP-003: separate Codex and Claude Code stdio processes share a durable inbox', () => {
  const root = stateRoot();
  const peerAReplies = runStdioClient('codex', root, [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'message_send', arguments: { to: 'claude-code', body: 'can you review?' } },
    },
  ]);
  assert.equal(peerAReplies[0].result.serverInfo.name, 'garden-hub');

  const claudeReplies = runStdioClient('claude-code', root, [
    { jsonrpc: '2.0', id: 3, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'message_inbox', arguments: {} } },
  ]);
  const [message] = JSON.parse(claudeReplies[1].result.content[0].text);
  assert.equal(message.from, 'codex');
  assert.equal(message.body, 'can you review?');
});

test('README documents both client registrations and the actor boundary', () => {
  const readme = readFileSync(README, 'utf8');
  assert.match(readme, /codex mcp add garden-hub/);
  assert.match(readme, /claude mcp add garden-hub/);
  assert.match(readme, /GHUB_MCP_ACTOR/);
  assert.match(readme, /restart/i);
  assert.match(readme, /does not cryptographically distinguish/i);
});
