# Garden Hub

A small, local-first control plane for people who run several coding agents side by side. It has three independent parts, all plain Node.js with no runtime dependencies:

- **`tools/ghub-log.mjs`** - an append-only JSONL event log (`emit` and `tail`), one file per month, with a validated schema.
- **`tools/ghub-mcp-server.mjs`** - a local stdio MCP server for two jobs: durable threaded messages between named peers, and GitHub pull request handoff (watch, create, poll, review, merge).
- **`extensions/garden-hub-wake.mjs`** - an opt-in wake-up bridge so a client can notice a new inbox message.

See [INSTALL.md](INSTALL.md) for setup and [docs/channel-wake.md](docs/channel-wake.md) for the wake protocol.

## Event log

```sh
node tools/ghub-log.mjs emit --type TASK_CLAIMED --agent agent-1 --payload '{"task":"example"}'
node tools/ghub-log.mjs tail --agent agent-1 --limit 20
```

Events are validated (`event_id`, `ts`, `type`, `agent_id`, `payload` are required) and appended atomically to `events-YYYY-MM.jsonl` in the store directory.

## Collaboration MCP

The server uses Node built-ins and the local, already-authenticated `gh` CLI. It does not store GitHub credentials or keys.

```sh
codex mcp add garden-hub \
  --env GHUB_MCP_ACTOR=codex \
  --env GHUB_MCP_PEERS=codex,claude-code \
  --env GHUB_MCP_STATE_DIR=/absolute/path/to/shared-inbox \
  -- node /absolute/path/to/garden-hub/tools/ghub-mcp-server.mjs

claude mcp add garden-hub \
  -e GHUB_MCP_ACTOR=claude-code \
  -e GHUB_MCP_PEERS=codex,claude-code \
  -e GHUB_MCP_STATE_DIR=/absolute/path/to/shared-inbox \
  -- node /absolute/path/to/garden-hub/tools/ghub-mcp-server.mjs
```

Restart the affected client sessions after registration. Each client is bound to its own actor by `GHUB_MCP_ACTOR`, so a tool argument cannot claim to be the other peer. A message is kept while the peer is offline. PR watches are polled while an MCP client is running; there is no daemon or webhook.

The configured actor does not cryptographically distinguish one client from another at GitHub when both use the same local `gh` login, so GitHub-author identity is checked again before review or merge.

### PR safety

`pr_merge` fails closed until a prior `pr_poll` observed a non-author approval for the current head and base. It refuses a stale approval, unresolved review threads and current change requests, then passes the expected head SHA to GitHub's merge command. The server relays review text supplied by the calling agent; it does not write review text itself.

## Tests

```sh
npm install
npm test            # event log and MCP unit tests (node --test)
npm run test:orca   # collaboration MCP spec tests
npm run test:wake   # wake contract tests (offline)
```

## Part of ANIMA

Garden Hub is a companion tool of [ANIMA](https://github.com/rfcclub/anima), a multi-agent runtime with an issue-to-pull-request-to-merge workflow. It is usable on its own with any MCP-capable coding client.
