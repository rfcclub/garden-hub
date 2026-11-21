import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { createStore } from '../../tools/ghub-mcp-store.mjs';
import { INBOX_INSTRUCTION } from '../../tools/ghub-mcp-wake.mjs';
import { randomUUID } from 'node:crypto';

test('installed OMP wakes its live session, reads, replies and acknowledges', {
  timeout: 90_000, skip: process.env.GHUB_TEST_LIVE_OMP !== '1',
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'ghub-omp-native-'));
  const ready = join(root, 'ready'), receipt = join(root, 'receipt.json');
  const state = join(root, 'state');
  const command = process.env.GHUB_TEST_OMP || '/opt/homebrew/bin/omp';
  writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { 'garden-hub': {
    command: process.execPath, args: [resolve('tools/ghub-mcp-server.mjs')],
    env: { GHUB_MCP_ACTOR: 'codex', GHUB_MCP_STATE_DIR: state, GHUB_MCP_WAKE_ADAPTER: 'omp' },
  } } }));
  const child = spawn(command, [
    '--mode', 'rpc', '--no-session', '--no-extensions', '--no-skills', '--no-lsp', '--no-pty', '--no-tools',
    '-e', resolve('extensions/garden-hub-wake.mjs'),
    '-e', resolve('tests/common-mcp-channel-wake/fixtures/observe-omp-input.mjs'),
    '--cwd', root,
  ], {
    env: { ...process.env, PI_CODING_AGENT_DIR: join(root, 'agent'),
      GHUB_TEST_READY: ready, GHUB_TEST_RECEIPT: receipt },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', data => { output = (output + data).slice(-5000); });
  child.stderr.on('data', data => { output = (output + data).slice(-5000); });
  async function until(path) {
    const end = Date.now() + 60_000;
    while (!existsSync(path) && Date.now() < end && child.exitCode === null) await setTimeout(50);
    assert.ok(existsSync(path), `missing ${path}; exit=${child.exitCode}; output=${output}`);
  }
  try {
    await until(ready);
    const peer = createStore({ root: state, actor: 'claude-code', peers: ['codex', 'claude-code'] });
    const nonce = randomUUID();
    const original = peer.sendMessage({ to: 'codex',
      body: `Live channel-wake acceptance probe ${nonce}. Please reply with exactly "${nonce}:ok" on this thread, then acknowledge this original message.` });
    await until(receipt);
    const observed = JSON.parse(readFileSync(receipt, 'utf8'));
    assert.equal(typeof observed.sessionId, 'string');
    assert.ok(observed.sessionId.length > 0);
    const userInputs = observed.messages.filter(message => message.role === 'user');
    assert.ok(userInputs.some(message => JSON.stringify(message.content).includes(INBOX_INSTRUCTION)));
    assert.ok(userInputs.every(message => !JSON.stringify(message.content).includes(nonce)));
    const calls = observed.messages.flatMap(message => message.toolCalls || []);
    for (const name of ['message_inbox', 'message_reply', 'message_ack']) {
      assert.ok(calls.some(call => call.endsWith(name)), `missing ${name}`);
    }
    assert.equal(createStore({ root: state, actor: 'codex', peers: ['codex', 'claude-code'] }).inbox().length, 0);
    const replies = peer.inbox();
    assert.equal(replies.length, 1);
    assert.equal(replies[0].replyTo, original.id);
    assert.equal(replies[0].threadId, original.threadId);
    assert.ok(replies[0].body.includes(nonce));
    const proof = { boundary: 'live OMP session read/reply/ack',
      sessionId: observed.sessionId, originalId: original.id,
      threadId: original.threadId, replyId: replies[0].id, calls,
      models: [...new Set(observed.messages.filter(message => message.model)
        .map(message => `${message.provider}/${message.model}`))] };
    if (process.env.GHUB_TEST_EVIDENCE) writeFileSync(process.env.GHUB_TEST_EVIDENCE, JSON.stringify(proof, null, 2));
    console.log(JSON.stringify(proof));
  } finally {
    child.kill();
    if (child.exitCode === null) await new Promise(resolve => child.once('exit', resolve));
    rmSync(root, { recursive: true, force: true });
  }
});
