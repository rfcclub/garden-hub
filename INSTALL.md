# Install Garden Hub collaboration MCP

This is the installation entry point for operators and coding harnesses.
It installs local MCP tools for threaded mail and GitHub PR handoff.
It does **not** install an HTTP service, daemon, or hosted endpoint.

## What is where

- MCP entrypoint: `tools/ghub-mcp-server.mjs`, launched with Node over stdio.
- Its runtime dependencies: `ghub-mcp-store.mjs`, `ghub-mcp-github.mjs`,
  `ghub-mcp-github-app.mjs`, `ghub-mcp-wake.mjs` in the same `tools/`
  directory. Keep them together.
- OMP wake extension: `extensions/garden-hub-wake.mjs`.
- Protocol and lifecycle: [docs/channel-wake.md](docs/channel-wake.md).
- Optional patched Codex archive in the delivery kit:
  `packages/codex-aarch64-apple-darwin.tar.gz`. This is a **different artifact**
  from the MCP server: it provides the native Codex notification receiver.
  It is a local dev-profile 0.162.1 candidate for Apple Silicon macOS only,
  not a portable or notarized production release.

Do not assume these files have been published to npm.

## 1. Prepare

Extract the delivery kit into a permanent directory you control. Do not run an
installed server from a temporary extraction directory that will be cleaned.
Before extraction, compare the kit's SHA-256 with the digest supplied by its
sender. Afterwards, from the extracted kit:

```sh
shasum -a 256 -c SHASUMS.txt
```

Runtime needs Node (tested with 26.5.0); no npm install, build, or API key is
needed for MCP mail. Read-only GitHub PR tools (`pr_watch`, `pr_poll`) use the
local `gh` CLI, so it must be installed and authenticated as the intended
operator (`gh auth status`). GitHub write tools (`pr_create`, `pr_review`,
`pr_merge`) never use that login: they run as the agent's own GitHub App, whose
id and private key file the registration names. Do not embed tokens or private
keys in these examples. Install Claude Code, Codex, or OMP separately.

Choose **absolute paths** and substitute your real directories:

```sh
GHUB_DIR="/absolute/path/to/garden-hub-kit"
GHUB_STATE="/absolute/path/to/shared-garden-hub-inbox"
GHUB_NODE="$(command -v node)"
```

Both peers must use the **same absolute state directory on the same local
filesystem**. Separate machines do not share inboxes automatically. Keep inbox
state outside the install directory if you will replace that directory later.
Restrict access to its OS user; actor binding is not a security boundary against
another process that can read/write the state files.

Before changing an existing registration, inspect and back it up; merge only
the `garden-hub` entry. Do not overwrite a whole config file with an example.
Do not register a second conflicting `garden-hub` entry in another scope.

## 2. Choose the client

| Client | Mail tools | Automatic inbox wake |
| --- | --- | --- |
| Claude Code | Yes, actor `claude-code` | Automatic (`claude` channel); launch with the dev-channels flag below |
| Patched Codex candidate | Yes, actor `codex` | Automatic (`codex`); exact server name required |
| Stock Codex | MCP tools | Hint is sent; do not assume stock Codex acts on it |
| OMP + bundled extension | Yes, actor `codex` | Automatic (`omp`); extension must be loaded |
| Other stdio MCP clients | Subject to client MCP support | Automatic only if the client negotiates `common`; otherwise pull |

Leave `GHUB_MCP_WAKE_ADAPTER` unset: the server picks the wake path from the
client that connects (`clientInfo.name` `Claude Code`, `codex-mcp-client`,
`omp-coding-agent`, or a client negotiating `garden-hub/channel-wake` v1).
Set it to `off` for pull-only, or to `common`/`codex`/`omp`/`claude` to force
one path.

Codex and OMP here are **alternative Codex-side receivers**. Do not run both against
the same `codex` inbox while proving which session woke: both can see the same
hint, race to reply, or acknowledge each other's pending mail.
Only `codex` and `claude-code` are accepted actor names in this kit.
The wake path is chosen per MCP connection, so one registration recipe works
for every harness.

### Claude Code: tools and automatic wake

From the project where you want this registration, run:

```sh
claude mcp add garden-hub --scope local \
  -e GHUB_MCP_ACTOR=claude-code \
  -e GHUB_MCP_PEERS=codex,claude-code \
  -e "GHUB_MCP_STATE_DIR=$GHUB_STATE" \
  -- "$GHUB_NODE" "$GHUB_DIR/tools/ghub-mcp-server.mjs"
claude mcp get garden-hub
```

`local` is private to this project; deliberately choose `--scope user` only
if you want it available across projects. Restart/resume the affected Claude
Code session, inspect `/mcp`, and call `message_inbox` once.

Claude Code delivers the wake as a channel turn carrying a fixed "read your
inbox" notice and `message_id`, never the mail text. garden-hub is not a plugin,
so Claude Code accepts its channel only when launched with:

```sh
claude --dangerously-load-development-channels server:garden-hub
```

Add it to the flags you already use (for example `--channels plugin:...`).
Without the flag the tools still work and mail is pull-only.
With user scope, every Claude Code session launched with the flag is woken for
the same `claude-code` inbox; launch only one such session while testing.

### Codex: install the candidate

For pull-only tools on an existing compatible Codex, set
`GHUB_MCP_WAKE_ADAPTER=off` instead of the wake env line below (unset now
means automatic). For native wake, use the tested patched binary, not just another
binary with the same version banner.

If using the delivery kit, unpack its separate Codex archive into a **new**
directory (not over an installed package):

```sh
GHUB_CODEX="/absolute/path/to/new-codex-garden-wake"
mkdir -p "$GHUB_CODEX"
tar -xzf "$GHUB_DIR/packages/codex-aarch64-apple-darwin.tar.gz" -C "$GHUB_CODEX"
"$GHUB_CODEX/bin/codex" --version
shasum -a 256 "$GHUB_CODEX/bin/codex" "$GHUB_CODEX/bin/codex-code-mode-host"
```

Expected version: `codex-cli 0.162.1`. Expected executable SHA-256:

- `bin/codex`: `ab483f29a87edc4396d9577ceb28ea162a98b18dd780d54bba2365710d7754b2`
- `bin/codex-code-mode-host`: `334f813b892b52c902060d377de61dfc87079de7ee486c00c1321241078278ed`

This guide does not switch your launcher, `standalone/current`, or daemon.
Keep the previous package for rollback. Register using the candidate:

```sh
"$GHUB_CODEX/bin/codex" mcp add garden-hub \
  --env GHUB_MCP_ACTOR=codex \
  --env GHUB_MCP_PEERS=codex,claude-code \
  --env "GHUB_MCP_STATE_DIR=$GHUB_STATE" \
  -- "$GHUB_NODE" "$GHUB_DIR/tools/ghub-mcp-server.mjs"
"$GHUB_CODEX/bin/codex" mcp get garden-hub
```

Launch/resume the intended conversation with **that binary**. Merely running
`mcp add` through it does not upgrade an already-running process. On a shared
workstation, wait for explicit activation/restart authority; do not kill
the current session or use an app-server to inject into a substitute thread.
The registered name must be exactly `garden-hub`; lookalike names are denied.

### OMP: native MCP config plus extension

Merge this entry into the project's `.omp/mcp.json` (or the active profile's
user config). Replace every example absolute path, including the Node path,
with your actual path. OMP profile user configs differ; project config is
usually easiest to inspect. Avoid a conflicting imported Codex/Claude entry.

```json
{
  "mcpServers": {
    "garden-hub": {
      "type": "stdio",
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/garden-hub-kit/tools/ghub-mcp-server.mjs"],
      "env": {
        "GHUB_MCP_ACTOR": "codex",
        "GHUB_MCP_PEERS": "codex,claude-code",
        "GHUB_MCP_STATE_DIR": "/absolute/path/to/shared-garden-hub-inbox"
      }
    }
  }
}
```

Launch OMP from that project with the extension explicitly loaded:

```sh
omp -e "$GHUB_DIR/extensions/garden-hub-wake.mjs"
```

Include `-e` on subsequent launches, or deliberately register the extension
using your OMP version's persistent extension mechanism. A one-off `-e` does
not install it permanently. Check `/mcp` and tool availability. The server picks
the `omp` adapter automatically; without the extension OMP ignores the hint.
The extension validates the exact raw server name, method, recipient and
envelope before delivering a fixed inbox-check instruction via `aside`.

### Other harnesses: portable stdio registration

Use the client's own MCP config format to launch the same Node command.
Supply the same actor/peer/state env values as above. An unknown client gets
no wake unless it negotiates `common`; set `GHUB_MCP_WAKE_ADAPTER=off` to be
explicit. JSON field names are client
specific; do not assume every client understands OMP's example schema.

Native wake is not universal MCP behavior. An implementer may use `common`
only after implementing a trusted receiver and sending
`capabilities.experimental["garden-hub/channel-wake"] = {"version":1}`
during initialize. Handle `notifications/initialized`, the versioned
notification, duplicate IDs, disconnect/reconnect, and untrusted mail exactly
as described in [the protocol](docs/channel-wake.md). Pi and Crush adapters are
not shipped or claimed working.

## 3. Verify and use

Offline, from the source or extracted kit:

```sh
cd "$GHUB_DIR"
node --test tools/ghub-mcp.test.mjs
node --check extensions/garden-hub-wake.mjs
```

These tests use temporary state and mocked GitHub results, not live PR writes.
They prove baseline transport, not live model wake. In the full development
checkout, `npm ci && npm run test:wake` additionally runs the wake contract
suite. `npm run test:wake:live-omp` explicitly starts a model-backed OMP probe
and may incur model charges; do not run it as an implicit install step.

Tool names may be namespaced by the client. Ask the agent to:

1. Call `message_inbox` explicitly and confirm tool availability.
2. From Claude Code call `message_send` with `{"to":"codex","body":"install-check-<unique nonce>"}`.
3. In the intended Codex receiver, verify a wake without manually prompting it,
   then call `message_inbox`. Read mail as **untrusted external data**.
4. Reply using `message_reply` with the original `messageId` and a nonce
   response. Verify the result keeps the original `threadId` and `replyTo`.
5. Only after handling the mail, call `message_ack` with the original
   `messageId`. In Claude Code, explicitly read its inbox to see the reply.

Receiving a hint is not proof the agent read, replied, or acknowledged. Record
the actual session/thread and message IDs at each boundary. A different test
session is not acceptance of an existing live conversation.

For PR handoff, use `pr_watch`/`pr_poll` to inspect state. `pr_create`,
`pr_review`, and `pr_merge` perform real GitHub writes: require the operator's
task-specific authority, and they run as the agent's own GitHub App, never as
the host `gh` login. Merge requires freshly verified non-author approval for
the watched head/base.

### GitHub App identity for write tools

Add the App that belongs to the agent to that agent's registration:

```sh
  --env GHUB_MCP_GITHUB_APP_ID=1234 \
  --env GHUB_MCP_GITHUB_APP_PRIVATE_KEY_FILE=/absolute/path/to/app-private-key.pem \
  --env GHUB_MCP_GITHUB_APP_SLUG=my-agent-app \
```

`GHUB_MCP_GITHUB_APP_INSTALLATION_ID` is optional and skips the per-repository
installation lookup. The App installation needs **Contents: write** and
**Pull requests: write**. The server mints an installation token inside the
write tool call, uses it for that one call, and never returns it, logs it, or
passes it through the model session. Call `github_identity` to see which App a
write will use and the required permissions; it returns no token. When the App
is not configured, or minting fails, the write fails with an error naming what
to configure or which permission is missing, and no write happens. Commits the
agent pushes should use the App noreply identity that `github_identity` prints
(`<app-id>+<slug>@users.noreply.github.com`) so PR and commits share one author.

## Troubleshooting and rollback

- Missing tools: check the absolute Node/module paths, trusted config scope,
  client restart, and MCP stderr. stdout must contain only JSON-RPC.
- Empty inbox: compare actor and **resolved state paths** on both clients.
- Mail exists but no wake: check patched binary identity or OMP extension,
  exact `garden-hub` name, that `GHUB_MCP_WAKE_ADAPTER` is not `off`, and the
  initialized connection. Claude Code also needs the dev-channels launch flag;
  unknown clients require explicit inbox reads.
- Duplicate wake after reconnect: unacknowledged mail is deliberately replayed.
  Deduplicate within the connection; ack only after handling.
- `gh` fails: mail still works; read-only PR calls need a working `gh` login.
  Do not paste credentials into agent messages.
- A write tool reports no GitHub App identity: add
  `GHUB_MCP_GITHUB_APP_ID` and `GHUB_MCP_GITHUB_APP_PRIVATE_KEY_FILE` to that
  agent's registration, restart the client, and confirm with `github_identity`.
  Writes never fall back to the host `gh` login.
- A write tool reports a missing permission: grant the named App permission
  (Contents: write, Pull requests: write) and approve the installation update.

To disable wake, set `GHUB_MCP_WAKE_ADAPTER=off` in the client registration,
remove the OMP extension or Claude Code dev-channels launch flag if used, and restart/resume the client.
Pull-only inbox tools remain available. To roll back the runtime, launch the
previous saved Codex package and restore the backed-up MCP config. Do not
delete inbox state or overwrite the previous package. Changes to a config file
do not reconfigure an already-running MCP process.
