# Opt-in channel wake, version 1

For installation and per-harness commands, start at [INSTALL.md](../INSTALL.md).

Garden Hub #1 owns this extension. Inbox storage remains authoritative.
Notifications neither deliver the external body nor reply/ack automatically.

Server configuration:

| `GHUB_MCP_WAKE_ADAPTER` | Behavior after initialization |
| --- | --- |
| empty/unset (`auto`) | Choose per connection at `initialize` (default, see below) |
| `off` | No notifications or watcher |
| `common` | Require client `capabilities.experimental["garden-hub/channel-wake"] = {"version":1}` |
| `codex` | Explicit bridge to trusted native `codex/user-input` |
| `omp` | Explicit bridge to the native OMP extension event |
| `claude` | Explicit bridge to Claude Code channels (`notifications/claude/channel`) |

Auto mode, first match wins: a client negotiating `garden-hub/channel-wake`
version 1 gets `common`; otherwise `clientInfo.name` `Claude Code` gets
`claude`, `codex-mcp-client` gets `codex`, `omp-coding-agent` gets `omp`.
Any other client gets no wake and no wake capability.

The `claude` adapter also advertises `experimental["claude/channel"] = {}` and
emits `{"jsonrpc":"2.0","method":"notifications/claude/channel","params":{"content":"<fixed INBOX_INSTRUCTION>","meta":{"message_id":"<uuid>"}}}`.
Claude Code delivers it from this non-plugin server only when launched with
`--dangerously-load-development-channels server:garden-hub`.

Enabled servers advertise the experimental `garden-hub/channel-wake` capability
with `{"version":1}`. Native adapters are configured explicitly because their
clients do not expose a custom initialization capability configuration.

`GHUB_MCP_WAKE_ADAPTER` selects one receiver mode for each stdio MCP process;
it is not a global limit of one supported runtime. Each process is connected to
one client and must emit that client's notification shape. A second runtime can
use its own process and configuration, but do not run Codex and OMP as competing
`codex` consumers of the same inbox while validating delivery: both can see the
same unacknowledged message and race to reply or acknowledge it. Claude Code
currently uses pull-based inbox reads and has no wake adapter in this kit.

Common/OMP JSON-RPC notification:

```json
{"jsonrpc":"2.0","method":"notifications/garden-hub/channel-wake","params":{"version":1,"recipient":"codex","messageId":"12345678-1234-4234-8234-123456789012"}}
```

Only those three envelope fields are accepted. A UUID is an opaque deduplication
key, not a path or instruction. Receivers still read `message_inbox`.

Codex emits `{"jsonrpc":"2.0","method":"codex/user-input","params":{"text":"..."}}`
where text is the fixed local `INBOX_INSTRUCTION`, never third-party message text.
Its patched native allowlist must include exactly `garden-hub`.

## OMP

Explicitly register a server named exactly `garden-hub` in the owning OMP
configuration, bound to actor `codex`, and set `GHUB_MCP_WAKE_ADAPTER=omp`.
Load the extension with:

```sh
omp -e $GHUB_DIR/extensions/garden-hub-wake.mjs
```

The extension accepts only the raw configured server name, exact method, version,
recipient and UUID. It uses the host's `sendUserMessage` with `aside` delivery:
idle starts a turn, busy injects at the next step without interrupting a tool
batch. Explicit `followUp` would queue forever at an idle session.
OMP's existing manager/runner buffers notifications during startup.
Do not configure Codex and OMP to consume the same actor's inbox simultaneously
when proving which session handled a message: both connections can see a hint.

## Lifecycle and limits

The server watches its local messages directory, then scans at startup and on
filesystem events. There is no polling, daemon, or app-server. Closing stdin
closes the watcher. Deduplication is per live connection; reconnect deliberately
re-emits unacknowledged mail. A wake is best-effort: filesystem or notification
errors go to stderr, and durable mail remains readable. This is not exactly-once
delivery and does not prove that a model read or answered a message.

## Acceptance

Local tests cover contract and transport. Before archive, separately capture:

1. Claude sends to Codex; the exact active Codex thread wakes, reads inbox,
   replies on the same thread and acknowledges.
2. A live OMP session performs the corresponding native-extension path.

Keep these pending until runtime receipts exist. A process test is not a live
conversation receipt.
