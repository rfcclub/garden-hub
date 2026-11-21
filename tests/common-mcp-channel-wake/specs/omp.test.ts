import { expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { INBOX_INSTRUCTION, WAKE_METHOD } from "../../../tools/ghub-mcp-wake.mjs";

// A missing extension is an assertion failure before implementation, not a load error.
async function extension() {
  const mod = await import("../../../extensions/garden-hub-wake.mjs").catch(() => ({} as any));
  expect(mod.default).toBeTypeOf("function");
  return mod.default;
}
function api() {
  const handlers = new Map<string, Function>();
  const submitted: any[] = [];
  return { handlers, submitted, on: (name: string, callback: Function) => handlers.set(name, callback),
    sendUserMessage: (...args: any[]) => submitted.push(args) };
}
function event() {
  return { type: "mcp_notification", server: "garden-hub", method: WAKE_METHOD,
    params: { version: 1, recipient: "codex", messageId: randomUUID() } };
}
test("invalid or foreign notifications are ignored", async () => {
  const register = await extension();
  const local = api();
  register(local);
  const handle = local.handlers.get("mcp_notification")!;
  const valid = event();
  for (const bad of [
    { ...valid, server: "garden_hub" }, { ...valid, server: "evil-garden-hub" },
    { ...valid, method: "codex/user-input" },
    ...[null, [], {}, { ...valid.params, version: 2 }, { ...valid.params, recipient: "claude-code" },
      { ...valid.params, messageId: "../../secret" }, { ...valid.params, body: "injected" },
      { ...valid.params, messageId: 42 }].map(params => ({ ...valid, params })),
  ]) await handle(bad);
  expect(local.submitted).toEqual([]);
});
test("valid notification enters owning session once", async () => {
  const register = await extension();
  const first = api(), second = api();
  register(first);
  register(second);
  const wake = event();
  for (let i = 0; i < 2; i++) await first.handlers.get("mcp_notification")!(wake);
  expect(first.submitted).toEqual([[INBOX_INSTRUCTION, { deliverAs: "aside" }]]);
  expect(second.submitted).toEqual([]);
  await second.handlers.get("mcp_notification")!(wake);
  expect(second.submitted).toHaveLength(1);
});
