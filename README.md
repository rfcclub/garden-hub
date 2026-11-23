# Garden Hub

A small, local-first control plane for people who run several coding agents side by side. It has four independent parts, all plain Node.js with no runtime dependencies:

- **`tools/ghub-log.mjs`** - an append-only JSONL event log (`emit` and `tail`), one file per month, with a validated schema.
- **`tools/ghub-mcp-server.mjs`** - a local stdio MCP server for two jobs: durable threaded messages between named peers, and GitHub pull request handoff (watch, create, poll, review, merge).
- **`tools/ghub-dashboard.mjs`** - a read-only loopback dashboard over the event log and a local work database, configured by a JSON allowlist file.
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

## Dashboard

`tools/ghub-dashboard.mjs` is a read-only dashboard: a loopback-only HTTP server plus the static page in `dashboard/`. It uses Node built-ins only, reads the event log through `tools/ghub-log.mjs`, and reads a local SQLite work database through `node:sqlite`.

```sh
GHUB_DASHBOARD_CONFIG=/absolute/path/to/dashboard.json \
GHUB_WORK_DB=/absolute/path/to/works.db \
node tools/ghub-dashboard.mjs
```

Then open `http://127.0.0.1:47820/`. `GHUB_DASHBOARD_PORT` and `GHUB_DASHBOARD_CONFIG` are optional; the configuration file is optional too. There is **no default database path**: without `GHUB_WORK_DB`, `/api/works` reports `source: "unavailable"` and no error text, exactly as it does for a database it cannot read.

### Configuration file

The configuration file is JSON with optional lists. Every name in it is an allowlist entry: a value that is present is shown with its configured spelling, and any value that is not present is replaced by a neutral label. With no configuration file, every value is neutral, so nothing is leaked.

```json
{
  "agents": ["agent-1", "agent-2"],
  "projects": ["project-1"],
  "repositories": ["example-org/example-repo"],
  "eventTypes": ["TASK_CLAIMED", "BLOCKER_REPORTED"],
  "blockedReasons": [{ "pattern": "^needs-owner", "label": "Needs an owner" }]
}
```

| Key | Meaning | Neutral fallback |
| --- | --- | --- |
| `agents` | Agent ids shown on events | `Other agent` |
| `projects` | Project names shown on events | `Other project` |
| `repositories` | `owner/name` repositories shown on blocked work, and the only repositories whose pull-request URLs are returned | `Other repository` |
| `eventTypes` | Event types shown verbatim | `Other event` |
| `blockedReasons` | Regular expressions matched against `blocked_reason`; a matching entry is shown as its `label` (or the pattern itself, for a bare string) | `Other reason` |

The file is validated when the server starts: wrong types, an invalid regular expression, or a repository that is not `owner/name` stops the server with a configuration error rather than silently widening what is shown.

### Endpoints

- `GET /api/events?limit=60&cursor=...` - bounded pages of the event log, newest first. Only `ts`, `type`, `agent` and `project` cross the boundary; event payloads are never returned.
- `GET /api/works?limit=60&cursor=...` - bounded pages of blocked work, newest first. The cursor is a keyset over the last row shown, so a queue that changes between pages neither hides nor repeats a row.
- `GET /`, `/app.js`, `/styles.css` - the static page and its assets.

Safety properties: the server binds IPv4 loopback only; `Host` and `Origin` must be loopback; only `GET` is accepted; responses carry a restrictive `Content-Security-Policy`, `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`; pagination is bounded; and unknown paths return a plain 404 without reading files outside `dashboard/`.

### Work database schema

The dashboard only reads, and only from `works`:

| Column | Type | Used as |
| --- | --- | --- |
| `repo` | TEXT | Repository, matched against `repositories` |
| `issue` | INTEGER | Issue number; a non-positive or non-integer value becomes `null` |
| `state` | TEXT | Only rows with `state = 'blocked'` are selected |
| `blocked_reason` | TEXT | Matched against `blockedReasons` |
| `pr_url` | TEXT | Returned only when it is `https://github.com/<owner>/<name>/pull/<number>` for a configured repository; the host is always `github.com` and any other host yields `null` |
| `updated_at` | TEXT | ISO-8601 timestamp used for ordering and display |

Rows are selected with `WHERE state = 'blocked'`, ordered newest first by the instant of `updated_at` (`julianday(updated_at)`, so timestamps with mixed offsets compare as times rather than as text), then issue number, then the row's `rowid`. Rows whose `updated_at` is missing or unparseable sort last and are still reachable. The page cursor is a keyset over that whole ordering of the last row shown, so rows that enter or leave the blocked queue between two pages neither hide a row nor show a duplicate; the cursor is opaque and carries no repository name. Any other table in that database is ignored.

## Tests

```sh
npm install
npm test            # event log, MCP and dashboard unit tests (node --test)
npm run test:orca   # collaboration MCP spec tests
npm run test:wake   # wake contract tests (offline)
```

## Part of ANIMA

Garden Hub is a companion tool of [ANIMA](https://github.com/rfcclub/anima), a multi-agent runtime with an issue-to-pull-request-to-merge workflow. It is usable on its own with any MCP-capable coding client.
