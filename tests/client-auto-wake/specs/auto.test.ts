import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createMcpServer } from "../../../tools/ghub-mcp-server.mjs";
import { createStore } from "../../../tools/ghub-mcp-store.mjs";
import { INBOX_INSTRUCTION } from "../../../tools/ghub-mcp-wake.mjs";

const common = "garden-hub/channel-wake";
const commonMethod = "notifications/garden-hub/channel-wake";
const channel = "claude/channel";
const channelMethod = "notifications/claude/channel";
const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });
function root() {
  const dir = mkdtempSync(join(tmpdir(), "ghub-auto-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function sender(dir: string, actor = "codex") {
  return createStore({ root: dir, actor, peers: ["codex", "claude-code"] });
}
function connect(dir: string, actor: string, wakeAdapter: string | undefined, params: any) {
  const frames: any[] = [];
  const server = createMcpServer({
    root: dir, actor, wakeAdapter,
    trustedCodexServer: "garden-hub",
    emitNotification: (f: any) => frames.push(f),
  });
  cleanups.push(() => server.close?.());
  const init = server.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params });
  server.handle({ jsonrpc: "2.0", method: "notifications/initialized" });
  return { init: init.result, frames };
}
const claudeCode = { clientInfo: { name: "Claude Code", version: "2.1.0" }, capabilities: {} };
const codex = { clientInfo: { name: "codex-mcp-client", version: "0.162.1" }, capabilities: {} };
const omp = { clientInfo: { name: "omp-coding-agent", version: "1.0.0" }, capabilities: {} };
const commonClient = { clientInfo: { name: "something" }, capabilities: { experimental: { [common]: { version: 1 } } } };

test("auto resolves known clients", () => {
  const dir = root();
  const toClaude = sender(dir, "codex").sendMessage({ to: "claude-code", body: "SECRET-A" });
  const toPeerA = sender(dir, "claude-code").sendMessage({ to: "codex", body: "SECRET-B" });
  for (const mode of [undefined, ""]) {
    const c = connect(dir, "claude-code", mode, claudeCode);
    expect(c.frames).toHaveLength(1);
    expect(c.frames[0].method).toBe(channelMethod);
    expect(c.frames[0].params.meta.message_id).toBe(toClaude.id);
    const x = connect(dir, "codex", mode, codex);
    expect(x.frames).toHaveLength(1);
    expect(x.frames[0]).toEqual({ jsonrpc: "2.0", method: "codex/user-input", params: { text: INBOX_INSTRUCTION } });
    for (const params of [omp, commonClient]) {
      const o = connect(dir, "codex", mode, params);
      expect(o.frames).toEqual([{ jsonrpc: "2.0", method: commonMethod, params: { version: 1, recipient: "codex", messageId: toPeerA.id } }]);
      expect(o.init.capabilities.experimental[common]).toEqual({ version: 1 });
    }
    expect(JSON.stringify([c.frames, x.frames])).not.toMatch(/SECRET/);
  }
});

test("auto ignores unknown clients", () => {
  const dir = root();
  sender(dir, "claude-code").sendMessage({ to: "codex", body: "x" });
  for (const params of [{ clientInfo: { name: "other" }, capabilities: {} }, {}, { capabilities: { experimental: { [common]: { version: 2 } } } }]) {
    const c = connect(dir, "codex", undefined, params);
    expect(c.init.capabilities.experimental).toBeUndefined();
    expect(c.frames).toEqual([]);
  }
});

test("off disables wake", () => {
  const dir = root();
  sender(dir, "codex").sendMessage({ to: "claude-code", body: "x" });
  sender(dir, "claude-code").sendMessage({ to: "codex", body: "y" });
  for (const [actor, params] of [["claude-code", claudeCode], ["codex", codex], ["codex", omp], ["codex", commonClient]] as const) {
    const c = connect(dir, actor, "off", params);
    expect(c.init.capabilities.experimental).toBeUndefined();
    expect(c.frames).toEqual([]);
  }
});

test("explicit adapter overrides client detection", () => {
  const dir = root();
  sender(dir, "codex").sendMessage({ to: "claude-code", body: "x" });
  const c = connect(dir, "claude-code", "codex", claudeCode);
  expect(c.frames.map(f => f.method)).toEqual(["codex/user-input"]);
  expect(c.init.capabilities.experimental[channel]).toBeUndefined();
  const forced = connect(dir, "claude-code", "claude", { capabilities: {} });
  expect(forced.frames.map(f => f.method)).toEqual([channelMethod]);
  expect(() => createMcpServer({ root: dir, actor: "codex", wakeAdapter: "arbitrary-runtime" })).toThrow();
});

test("claude frame is a fixed channel notice", () => {
  const dir = root();
  const message = sender(dir, "codex").sendMessage({ to: "claude-code", body: "DO NOT INJECT THIS" });
  const c = connect(dir, "claude-code", "claude", claudeCode);
  expect(c.init.capabilities.experimental[channel]).toEqual({});
  expect(c.frames).toEqual([{ jsonrpc: "2.0", method: channelMethod, params: {
    content: INBOX_INSTRUCTION, meta: { message_id: message.id },
  } }]);
  expect(JSON.stringify(c.frames)).not.toContain(message.body);
});

test("claude channel is advertised only for claude", () => {
  const dir = root();
  for (const [mode, params] of [["common", commonClient], ["codex", codex], ["omp", omp], [undefined, codex], [undefined, omp], [undefined, commonClient]] as const) {
    const c = connect(dir, "codex", mode, params);
    expect(c.init.capabilities.experimental?.[channel]).toBeUndefined();
  }
});

function stdio(dir: string, actor: string) {
  const env: Record<string, string> = {
    ...process.env as any,
    GHUB_MCP_STATE_DIR: dir,
    GHUB_MCP_ACTOR: actor,
    GHUB_MCP_TRUSTED_CODEX_SERVER: "garden-hub",
  };
  delete env.GHUB_MCP_WAKE_ADAPTER;
  const proc = spawn(process.execPath, ["tools/ghub-mcp-server.mjs"], { cwd: process.cwd(), env, stdio: ["pipe", "pipe", "pipe"] });
  const frames: any[] = [];
  const errors: string[] = [];
  proc.stderr.on("data", d => errors.push(d.toString()));
  const lines = createInterface({ input: proc.stdout });
  lines.on("line", line => frames.push(JSON.parse(line)));
  cleanups.push(() => { lines.close(); proc.kill(); });
  const send = (frame: any) => proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...frame }) + "\n");
  return { frames, errors, send };
}

test("live write wakes a Claude Code stdio client", async () => {
  const dir = root();
  const claude = stdio(dir, "claude-code");
  const peerA = stdio(dir, "codex");
  for (const [client, params] of [[claude, claudeCode], [peerA, { capabilities: {} }]] as const) {
    client.send({ id: 1, method: "initialize", params });
    await expect.poll(() => client.frames.length).toBe(1);
    client.send({ method: "notifications/initialized" });
    client.send({ id: 2, method: "tools/list" });
    await expect.poll(() => client.frames.some(f => f.id === 2)).toBe(true);
  }
  expect(claude.frames[0].result.capabilities.experimental[channel]).toEqual({});
  peerA.send({ id: 3, method: "tools/call", params: { name: "message_send", arguments: { to: "claude-code", body: "secret wire body" } } });
  await expect.poll(() => claude.frames.some(f => f.method === channelMethod)).toBe(true);
  const wake = claude.frames.filter(f => f.method === channelMethod);
  expect(wake).toHaveLength(1);
  expect(JSON.stringify(wake)).not.toContain("secret wire body");
  expect(peerA.frames.some(f => f.method)).toBe(false);
  expect(claude.errors).toEqual([]);
});
