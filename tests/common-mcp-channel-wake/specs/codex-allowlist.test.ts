import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CODEX_TRUSTED_SERVERS,
  isTrustedCodexServer,
  SERVER_NAME,
} from "../../../tools/ghub-mcp-wake.mjs";
import { createMcpServer } from "../../../tools/ghub-mcp-server.mjs";
import { createStore } from "../../../tools/ghub-mcp-store.mjs";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });
function root() {
  const dir = mkdtempSync(join(tmpdir(), "ghub-codex-allow-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function sender(dir: string, actor = "claude-code") {
  return createStore({ root: dir, actor, peers: ["codex", "claude-code"] });
}
// `trusted: ""` models an unset opt-in; the advertised name never grants trust.
function connect(dir: string, { serverName = "garden-hub", trusted = "garden-hub" } = {}) {
  const frames: any[] = [];
  const server = createMcpServer({
    root: dir, actor: "codex", wakeAdapter: "codex", serverName, trustedCodexServer: trusted,
    emitNotification: (frame: any) => frames.push(frame),
  });
  cleanups.push(() => server.close?.());
  const init = server.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { capabilities: {} } });
  server.handle({ jsonrpc: "2.0", method: "notifications/initialized" });
  return { init: init.result, frames };
}

test("the native codex bridge needs an allowlisted name and a matching opt-in", () => {
  expect(SERVER_NAME).toBe("garden-hub");
  expect([...CODEX_TRUSTED_SERVERS]).toEqual(["garden-hub"]);
  // Explicit opt-in for the allowlisted name is the only granting combination.
  expect(isTrustedCodexServer("garden-hub", "garden-hub")).toBe(true);
  // A bare name is not trust on its own: that was the self-asserted default.
  expect(isTrustedCodexServer("garden-hub")).toBe(false);
  expect(isTrustedCodexServer("garden-hub", "")).toBe(false);
  for (const name of [
    "garden_hub", "evil-garden-hub", "garden-hub-evil", "Garden-Hub",
    "gardenhub", "", " garden-hub", "garden-hub ", "..", null, undefined, 42,
  ]) {
    expect(isTrustedCodexServer(name)).toBe(false);
    expect(isTrustedCodexServer(name, name)).toBe(false);
  }
  // Opting in to a different allowlisted name does not grant this one either.
  expect(isTrustedCodexServer("evil-garden-hub", "garden-hub")).toBe(false);
  expect(isTrustedCodexServer("garden-hub", "evil-garden-hub")).toBe(false);
});

test("a lookalike server name is denied the codex user-input bridge", () => {
  const dir = root();
  const message = sender(dir).sendMessage({ to: "codex", body: "DO NOT INJECT THIS" });
  for (const serverName of ["garden_hub", "evil-garden-hub", ""]) {
    // A lookalike advertised name cannot opt its own process in either.
    for (const trusted of ["", serverName]) {
      const { init, frames } = connect(dir, { serverName, trusted });
      expect(init.serverInfo.name).toBe(serverName);
      expect(init.capabilities.experimental).toBeUndefined();
      expect(frames).toEqual([]);
      expect(JSON.stringify(frames)).not.toContain(message.body);
    }
  }
  expect(sender(dir, "codex").inbox()).toHaveLength(1);
});

test("the trusted server name still routes a fixed wake, never the body", () => {
  const dir = root();
  const message = sender(dir).sendMessage({ to: "codex", body: "DO NOT INJECT THIS" });
  const { init, frames } = connect(dir);
  expect(init.serverInfo.name).toBe("garden-hub");
  expect(init.capabilities.experimental["garden-hub/channel-wake"]).toEqual({ version: 1 });
  expect(frames).toHaveLength(1);
  expect(frames[0].method).toBe("codex/user-input");
  expect(frames[0].params.text).toContain("message_inbox");
  expect(JSON.stringify(frames)).not.toContain(message.body);
  expect(JSON.stringify(frames)).not.toContain(message.id);
});

test("the server-name gate is scoped to the codex bridge, not a global policy", () => {
  const dir = root();
  sender(dir).sendMessage({ to: "codex", body: "DO NOT INJECT THIS" });
  // A non-codex adapter keeps its negotiated capability and its own shape under any name;
  // that path is trusted client-side (raw server name filtering in the host).
  const frames: any[] = [];
  const server = createMcpServer({
    root: dir, actor: "codex", wakeAdapter: "common", serverName: "evil",
    emitNotification: (frame: any) => frames.push(frame),
  });
  cleanups.push(() => server.close?.());
  const init = server.handle({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { capabilities: { experimental: { "garden-hub/channel-wake": { version: 1 } } } },
  });
  server.handle({ jsonrpc: "2.0", method: "notifications/initialized" });
  expect(init.result.serverInfo.name).toBe("evil");
  expect(init.result.capabilities.experimental["garden-hub/channel-wake"]).toEqual({ version: 1 });
  expect(frames.map(frame => frame.method)).toEqual(["notifications/garden-hub/channel-wake"]);
  expect(frames[0].method).not.toBe("codex/user-input");
  expect(JSON.stringify(frames)).not.toContain("DO NOT INJECT THIS");
});

test("the codex bridge is off unless the trusted name is explicitly opted in", () => {
  const dir = root();
  const message = sender(dir).sendMessage({ to: "codex", body: "DO NOT INJECT THIS" });
  // No opt-in: this process asserts no trust, so it gets no native ingress,
  // even when the codex adapter is requested explicitly or auto-detected.
  for (const wakeAdapter of ["codex", undefined]) {
    const frames: any[] = [];
    const server = createMcpServer({
      root: dir, actor: "codex", wakeAdapter,
      // No opt-in: pull-only, even for an explicitly requested codex adapter.
      trustedCodexServer: "",
      emitNotification: (frame: any) => frames.push(frame),
    });
    cleanups.push(() => server.close?.());
    const init = server.handle({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { clientInfo: { name: "codex-mcp-client" }, capabilities: {} },
    });
    server.handle({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(init.result.serverInfo.name).toBe("garden-hub");
    expect(init.result.capabilities.experimental).toBeUndefined();
    expect(frames).toEqual([]);
    expect(JSON.stringify(frames)).not.toContain(message.body);
  }
  expect(sender(dir, "codex").inbox()).toHaveLength(1);
});

test("the opt-in and the advertised name must agree to grant the bridge", () => {
  const dir = root();
  const message = sender(dir).sendMessage({ to: "codex", body: "DO NOT INJECT THIS" });
  // Opting in to a rename that is not allowlisted grants nothing.
  const renamed = connect(dir, { serverName: "renamed-locally", trusted: "renamed-locally" });
  expect(renamed.init.serverInfo.name).toBe("renamed-locally");
  expect(renamed.init.capabilities.experimental).toBeUndefined();
  expect(renamed.frames).toEqual([]);
  // An allowlisted name whose opt-in names something else is still denied.
  const mismatch = connect(dir, { serverName: "garden-hub", trusted: "evil-garden-hub" });
  expect(mismatch.init.capabilities.experimental).toBeUndefined();
  expect(mismatch.frames).toEqual([]);
  // The default advertised name with no opt-in stays pull-only.
  const noOptIn = connect(dir, { trusted: "" });
  expect(noOptIn.frames).toEqual([]);
  expect(JSON.stringify([renamed.frames, mismatch.frames, noOptIn.frames])).not.toContain(message.body);
});
