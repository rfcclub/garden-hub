import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { createMcpServer } from '../../../tools/ghub-mcp-server.mjs';
import { createStore } from '../../../tools/ghub-mcp-store.mjs';
import { WAKE_CAPABILITY, WAKE_METHOD } from '../../../tools/ghub-mcp-wake.mjs';

// A client may open a session with a discovery request instead of `initialize`.
// This server speaks the 2025 initialization lifecycle, answers that request
// with a generic method-not-found, and depends on the client falling back to
// `initialize`. These specs pin that dependency so a future "compatibility"
// answer cannot quietly move the session onto a lifecycle this server does not
// implement — the tools would keep working and wake would stop.
//
// Everything here is a synthetic protocol client driven in-process or over a
// real stdio pipe. A live third-party client's fallback behaviour is a separate
// host check, not part of `npm test`.

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function root() {
  const dir = mkdtempSync(join(tmpdir(), 'ghub-discovery-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function peer(dir: string) {
  return createStore({ root: dir, actor: 'codex', peers: ['codex', 'claude-code'] });
}

function connection(dir: string) {
  const frames: unknown[] = [];
  const errors: string[] = [];
  const server = createMcpServer({
    root: dir,
    actor: 'claude-code',
    wakeAdapter: 'common',
    emitNotification: (frame: unknown) => frames.push(frame),
    onWakeError: (error: Error) => errors.push(error.message),
  });
  cleanups.push(() => server.close?.());
  return { server, frames, errors };
}

// The frame shape a modern client opens with. No client identity matters here:
// discovery is answered the same way for every client.
const discovery = { jsonrpc: '2.0', id: 1, method: 'server/discover', params: {} };
const initialize = {
  jsonrpc: '2.0',
  id: 2,
  method: 'initialize',
  params: {
    protocolVersion: '2025-11-25',
    capabilities: { experimental: { [WAKE_CAPABILITY]: { version: 1 } } },
    clientInfo: { name: 'synthetic-discovery-client', version: '1.0.0' },
  },
};

test('[the-client-shall-receive-a-method-not-found-for-discovery-and-complete-the-legacy-handshake-mcp-001-discovery-answers-generically-and-writes-nothing]', () => {
  const dir = root();
  const { server } = connection(dir);

  const reply = server.handle(discovery);

  // The code stays a generic method-not-found: it is what clients fall back on.
  // It is not a version-mismatch response and must not become one by accident.
  expect(reply.result).toBeUndefined();
  expect(reply.error.code).toBe(-32601);
  expect(reply.error.message).toBe('method not found: server/discover');
  expect(reply.id).toBe(1);

  // Answering discovery must not be mistaken for an initialised connection:
  // no capability is advertised and no state is created by a read-only frame.
  expect(readdirSync(dir)).toEqual([]);
});

test('[the-client-shall-receive-a-method-not-found-for-discovery-and-complete-the-legacy-handshake-mcp-002-fallback-reaches-tools-and-starts-wake]', () => {
  const dir = root();
  // Mail that predates the connection: the startup scan must publish it, so the
  // spec does not depend on this host delivering a filesystem callback.
  const message = peer(dir).sendMessage({ to: 'claude-code', body: 'SECRET-BODY' });
  const { server, frames, errors } = connection(dir);

  expect(server.handle(discovery).error.code).toBe(-32601);

  const initialized = server.handle(initialize);
  expect(initialized.result.protocolVersion).toBe('2025-11-25');
  expect(initialized.result.serverInfo.name).toBe('garden-hub');
  expect(initialized.result.capabilities.tools).toEqual({});
  expect(initialized.result.capabilities.experimental[WAKE_CAPABILITY]).toEqual({ version: 1 });
  // Nothing is published before the client confirms initialization.
  expect(frames).toEqual([]);

  expect(server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeUndefined();

  const tools = server.handle({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} });
  expect(tools.result.tools.map((tool: { name: string }) => tool.name)).toContain('message_inbox');

  const inbox = server.handle({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'message_inbox', arguments: {} },
  });
  expect(JSON.parse(inbox.result.content[0].text).map((m: { id: string }) => m.id)).toEqual([message.id]);

  // The wake path starts on notifications/initialized, which is exactly what a
  // client that skipped `initialize` would never send.
  expect(frames).toEqual([{
    jsonrpc: '2.0',
    method: WAKE_METHOD,
    params: { version: 1, recipient: 'claude-code', messageId: message.id },
  }]);
  expect(JSON.stringify(frames)).not.toContain('SECRET-BODY');
  expect(errors).toEqual([]);
});

// The client-side shape of the fallback: wait for the reply that answers this
// id. A wake notification is a legal frame at any point after the client
// confirms initialization, and stdout writes are not ordered against the request
// queue, so "a new frame arrived" is not the same as "my reply arrived". Waiting
// on frame count instead of on the id is how the delayed-reply race hides: the
// wake lands first, the reply is still in flight, and the caller treats the
// envelope as the answer.
type Frame = { [key: string]: any };

async function awaitReply(frames: Frame[], id: number) {
  await expect.poll(() => frames.filter((frame) => frame.id === id).length > 0).toBe(true);
  const replies = frames.filter((frame) => frame.id === id);
  expect(replies).toHaveLength(1);
  return replies[0];
}

function stdio(dir: string, actor: string) {
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    GHUB_MCP_STATE_DIR: dir,
    GHUB_MCP_ACTOR: actor,
    GHUB_MCP_PEERS: 'codex,claude-code',
  };
  delete env.GHUB_MCP_WAKE_ADAPTER;
  const proc = spawn(process.execPath, ['tools/ghub-mcp-server.mjs'], {
    cwd: process.cwd(),
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const frames: any[] = [];
  const errors: string[] = [];
  proc.stderr.on('data', (chunk) => errors.push(chunk.toString()));
  const lines = createInterface({ input: proc.stdout });
  lines.on('line', (line) => frames.push(JSON.parse(line)));
  cleanups.push(() => { lines.close(); proc.kill(); });
  const send = (frame: unknown) => proc.stdin.write(`${JSON.stringify(frame)}\n`);
  return { frames, errors, send };
}

test('[the-client-shall-receive-a-method-not-found-for-discovery-and-complete-the-legacy-handshake-mcp-003-stdio-frame-order-keeps-the-fallback]', async () => {
  const dir = root();
  const message = peer(dir).sendMessage({ to: 'claude-code', body: 'wire body' });
  const client = stdio(dir, 'claude-code');

  // One request in flight at a time: a real client cannot fall back to
  // `initialize` before it has seen the discovery reply, and this spec should
  // fail if that dependency is ever broken rather than race it away.
  const request = async (frame: any) => {
    client.send(frame);
    return awaitReply(client.frames, frame.id);
  };

  expect(client.frames).toEqual([]);
  const discoveryReply = await request(discovery);
  expect(discoveryReply.result).toBeUndefined();
  expect(discoveryReply.error.code).toBe(-32601);
  expect(discoveryReply.error.message).toBe('method not found: server/discover');
  // Nothing was published off a frame that created no session.
  expect(client.frames.filter((f: any) => f.method === WAKE_METHOD)).toEqual([]);

  const initializeReply = await request(initialize);
  expect(initializeReply.result.protocolVersion).toBe('2025-11-25');
  expect(initializeReply.result.serverInfo.name).toBe('garden-hub');
  expect(initializeReply.result.capabilities.experimental[WAKE_CAPABILITY]).toEqual({ version: 1 });

  const initializedAt = client.frames.length;
  client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  const listReply = await request({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} });
  expect(listReply.result.tools.map((tool: { name: string }) => tool.name)).toContain('message_inbox');

  const inboxReply = await request({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'message_inbox', arguments: {} },
  });
  expect(JSON.parse(inboxReply.result.content[0].text).map((m: { id: string }) => m.id)).toEqual([message.id]);

  await expect.poll(() => client.frames.some((f: any) => f.method === WAKE_METHOD)).toBe(true);

  const wake = client.frames.filter((f: any) => f.method === WAKE_METHOD);
  expect(wake).toHaveLength(1);
  expect(wake[0].params).toEqual({ version: 1, recipient: 'claude-code', messageId: message.id });
  expect(JSON.stringify(wake)).not.toContain('wire body');

  // Order on the wire: no wake before the client confirms initialization, then
  // exactly one wake, and the replies keep the order the client asked in.
  const wakeAt = client.frames.findIndex((f: any) => f.method === WAKE_METHOD);
  expect(wakeAt).toBeGreaterThanOrEqual(initializedAt);
  const ids = client.frames.filter((f: any) => f.id !== undefined).map((f: any) => f.id);
  expect(ids).toEqual([1, 2, 3, 4]);

  expect(client.errors).toEqual([]);
});

test('[the-client-shall-receive-a-method-not-found-for-discovery-and-complete-the-legacy-handshake-mcp-004-a-wake-frame-before-a-delayed-reply-is-not-the-answer]', async () => {
  // Deterministic ordering, no wall clock: the wake frame is already present and
  // the reply to the request arrives only afterwards. This is the shape a slow
  // stdout write produces in a real session, pinned without its timing.
  const frames: Frame[] = [
    { jsonrpc: '2.0', method: WAKE_METHOD, params: { version: 1, recipient: 'claude-code', messageId: 'pending-message' } },
  ];
  queueMicrotask(() => frames.push({ jsonrpc: '2.0', id: 9, result: { tools: [] } }));

  const reply = await awaitReply(frames, 9);

  expect(reply.id).toBe(9);
  expect(reply.result).toEqual({ tools: [] });
  // The wake was waited past, not consumed: it is still one envelope on the wire.
  expect(frames.filter((frame) => frame.method === WAKE_METHOD)).toHaveLength(1);
  expect(frames).toHaveLength(2);
});
