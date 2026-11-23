import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createMcpServer } from "../../../tools/ghub-mcp-server.mjs";
import { createStore } from "../../../tools/ghub-mcp-store.mjs";

const capability = "garden-hub/channel-wake";
const method = "notifications/garden-hub/channel-wake";
const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });
function root() {
  const dir = mkdtempSync(join(tmpdir(), "ghub-wake-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function sender(dir: string, actor = "claude-code") {
  return createStore({ root: dir, actor, peers: ["codex", "claude-code"] });
}
function connection(dir: string, adapter = "common", actor = "codex") {
  const frames: any[] = [];
  const server = createMcpServer({
    root: dir, actor, wakeAdapter: adapter,
    // Ops opt in to native codex ingress in the registration env.
    trustedCodexServer: "garden-hub",
    emitNotification: (frame: any) => frames.push(frame),
  });
  cleanups.push(() => server.close?.());
  return { server, frames };
}
function initialize(server: any, caps: any = { experimental: { [capability]: { version: 1 } } }) {
  return server.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { capabilities: caps } });
}
function initialized(server: any) {
  server.handle({ jsonrpc: "2.0", method: "notifications/initialized" });
}

test("disabled connection stays silent", () => {
  const dir = root();
  sender(dir).sendMessage({ to: "codex", body: "private" });
  const { server, frames } = connection(dir, "off");
  expect(initialize(server).result.capabilities.experimental).toBeUndefined();
  initialized(server);
  expect(frames).toEqual([]);
});

test("common client negotiates version", () => {
  const dir = root();
  sender(dir).sendMessage({ to: "codex", body: "private" });
  for (const caps of [{}, { experimental: { [capability]: { version: 2 } } }]) {
    const { server, frames } = connection(dir);
    expect(initialize(server, caps).result.capabilities.experimental[capability].version).toBe(1);
    initialized(server);
    expect(frames).toEqual([]);
  }
});

test("initialized recipient receives body-free wake", () => {
  const dir = root();
  const message = sender(dir).sendMessage({ to: "codex", body: "DO NOT INJECT THIS" });
  for (const adapter of ["common", "codex", "omp"]) {
    const { server, frames } = connection(dir, adapter);
    initialized(server); // before the handshake is never sufficient
    expect(frames).toEqual([]);
    initialize(server);
    expect(frames).toEqual([]);
    initialized(server);
    expect(frames).toHaveLength(1);
    expect(JSON.stringify(frames)).not.toContain(message.body);
    if (adapter === "codex") {
      expect(frames[0].method).toBe("codex/user-input");
      expect(frames[0].params.text).toContain("message_inbox");
      expect(Object.keys(frames[0].params)).toEqual(["text"]);
    } else {
      expect(frames[0]).toEqual({ jsonrpc: "2.0", method, params: {
        version: 1, recipient: "codex", messageId: message.id,
      } });
    }
  }
  expect(() => connection(dir, "arbitrary-runtime")).toThrow();
});

test("duplicate file events do not duplicate wake", async () => {
  const dir = root();
  const { server, frames } = connection(dir);
  initialize(server);
  initialized(server);
  const original = sender(dir).sendMessage({ to: "codex", body: "one" });
  await expect.poll(() => frames.length).toBe(1);
  initialized(server);
  sender(dir, "codex").sendMessage({ to: "claude-code", body: "wrong recipient" });
  // Second valid message proves another scan has happened.
  const next = sender(dir).sendMessage({ to: "codex", body: "two" });
  await expect.poll(() => frames.length).toBe(2);
  expect(frames.map(f => f.params.messageId)).toEqual([original.id, next.id]);
  expect(sender(dir, "codex").inbox()).toHaveLength(2);
});

test("reconnect rescans offline mail", () => {
  const dir = root();
  const read = sender(dir, "codex");
  const send = sender(dir);
  const acked = send.sendMessage({ to: "codex", body: "already read" });
  read.ackMessage({ messageId: acked.id });
  const pending = send.sendMessage({ to: "codex", body: "offline" });
  read.sendMessage({ to: "claude-code", body: "foreign" });
  for (let i = 0; i < 2; i++) {
    const { server, frames } = connection(dir);
    initialize(server);
    initialized(server);
    expect(frames.map(f => f.params.messageId)).toEqual([pending.id]);
    server.close?.();
  }
  expect(read.inbox()).toHaveLength(1);
});

function stdio(dir: string, actor: string, adapter: string) {
  const proc = spawn(process.execPath, ["tools/ghub-mcp-server.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      GHUB_MCP_STATE_DIR: dir,
      GHUB_MCP_ACTOR: actor,
      GHUB_MCP_WAKE_ADAPTER: adapter,
      GHUB_MCP_TRUSTED_CODEX_SERVER: 'garden-hub',
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const frames: any[] = [];
  const errors: string[] = [];
  proc.stderr.on("data", data => errors.push(data.toString()));
  const lines = createInterface({ input: proc.stdout });
  lines.on("line", line => frames.push(JSON.parse(line)));
  cleanups.push(() => { lines.close(); proc.kill(); });
  const send = (frame: any) => proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...frame }) + "\n");
  return { proc, frames, errors, send };
}

test("live filesystem write wakes stdio", async () => {
  const dir = root();
  const recipient = stdio(dir, "codex", "codex");
  const peer = stdio(dir, "claude-code", "");
  for (const client of [recipient, peer]) {
    client.send({ id: 1, method: "initialize", params: { capabilities: {} } });
    await expect.poll(() => client.frames.length).toBe(1);
    client.send({ method: "notifications/initialized" });
    // An ordered ping ensures initialized was processed.
    client.send({ id: 2, method: "tools/list" });
    await expect.poll(() => client.frames.some(f => f.id === 2)).toBe(true);
  }
  peer.send({ id: 3, method: "tools/call", params: { name: "message_send", arguments: { to: "codex", body: "secret wire body" } } });
  await expect.poll(() => recipient.frames.some(f => f.method === "codex/user-input")).toBe(true);
  const wake = recipient.frames.filter(f => f.method === "codex/user-input");
  expect(wake).toHaveLength(1);
  expect(JSON.stringify(wake)).not.toContain("secret wire body");
  expect(peer.frames.some(f => f.method === "codex/user-input")).toBe(false);
  expect(recipient.errors).toEqual([]);
  expect(sender(dir, "codex").inbox()).toHaveLength(1);
});
