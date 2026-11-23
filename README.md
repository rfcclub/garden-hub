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

## Dashboard service

The dashboard is a foreground process by default:

```sh
node tools/ghub-dashboard.mjs          # stop it with Ctrl-C
```

On macOS it can also run as a launchd user agent, so it starts at login and is
restarted after a crash or a closed terminal:

```sh
tools/service/ghub-service.sh install     # write and load the agent [--force]
tools/service/ghub-service.sh status      # loaded? what does /api/events answer?
tools/service/ghub-service.sh uninstall   # unload and remove it
tools/service/ghub-service.sh print       # show the plist; changes nothing
```

`install` writes `~/Library/LaunchAgents/com.anima.garden-hub-dashboard.plist`
(mode 644) and bootstraps it, refusing to replace a plist that differs from the
rendered one unless `--force` is given. The agent runs this checkout's
`tools/ghub-dashboard.mjs` with the absolute node and repository paths resolved
at install time, sets `GHUB_EVENTS_DIR` to this checkout's `events/` directory,
leaves `GHUB_WORK_DB` unset (so `/api/works` reports `source: "unavailable"`
unless the database is configured elsewhere), listens only on `127.0.0.1` at
`GHUB_DASHBOARD_PORT` (default `47820`) and logs to
`~/Library/Logs/anima/garden-hub-dashboard.log`. It holds no secret. A missing
node or repository path is an error; nothing is guessed.

## Tests

```sh
npm install
npm test            # event log and MCP unit tests (node --test)
npm run test:orca   # collaboration MCP spec tests
npm run test:wake   # wake contract tests (offline)
npm run test:watch-probe  # does this host's fs.watch deliver callbacks?
```

## Part of ANIMA

Garden Hub is a companion tool of [ANIMA](https://github.com/rfcclub/anima), a multi-agent runtime with an issue-to-pull-request-to-merge workflow. It is usable on its own with any MCP-capable coding client.
