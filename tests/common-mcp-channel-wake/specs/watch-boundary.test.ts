import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMcpServer } from "../../../tools/ghub-mcp-server.mjs";
import { createStore } from "../../../tools/ghub-mcp-store.mjs";

const capability = "garden-hub/channel-wake";
const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });
function root() {
  const dir = mkdtempSync(join(tmpdir(), "ghub-watch-boundary-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function sender(dir: string, actor = "claude-code") {
  return createStore({ root: dir, actor, peers: ["codex", "claude-code"] });
}

// A host may accept a filesystem watcher and never deliver a callback for a
// later write. Garden Hub #6 observed that on macOS arm64. This inert watcher
// reproduces it on every host, without depending on the local filesystem.
function inertWatcher() {
  return { on() {}, close() {} };
}

function connection(dir: string, watchDirectory: any) {
  const frames: any[] = [];
  const errors: string[] = [];
  const server = createMcpServer({
    root: dir, actor: "codex", wakeAdapter: "common",
    emitNotification: (frame: any) => frames.push(frame),
    onWakeError: (error: any) => errors.push(error.message),
    watchDirectory,
  });
  cleanups.push(() => server.close?.());
  return { server, frames, errors };
}

function handshake(server: any) {
  server.handle({ jsonrpc: "2.0", id: 1, method: "initialize",
    params: { capabilities: { experimental: { [capability]: { version: 1 } } } } });
  server.handle({ jsonrpc: "2.0", method: "notifications/initialized" });
}

test("host watcher that arms but never fires leaves mail durable and unwoken", async () => {
  const dir = root();
  const { server, frames, errors } = connection(dir, inertWatcher);
  handshake(server);
  const message = sender(dir).sendMessage({ to: "codex", body: "durable" });
  // Live wake is bounded by the host watcher; persistence must not be mistaken
  // for delivery, so no frame appears and the failure stays silent on stdout.
  await new Promise(resolve => setTimeout(resolve, 250));
  expect(frames.filter(f => f.method === "notifications/garden-hub/channel-wake")).toEqual([]);
  expect(errors).toEqual([]);
  expect(sender(dir, "codex").inbox().map(m => m.id)).toEqual([message.id]);
});

test("startup scan still wakes on a host watcher that never fires", () => {
  const dir = root();
  const message = sender(dir).sendMessage({ to: "codex", body: "offline" });
  const { server, frames } = connection(dir, inertWatcher);
  handshake(server);
  expect(frames.map(f => f.params.messageId)).toEqual([message.id]);
});
