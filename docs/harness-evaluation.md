# Harness evaluation: native structured interfaces vs the interactive CLI

Evaluation for [issue #7](https://github.com/rfcclub/garden-hub/issues/7).
This is a bounded proof of concept, not a runtime selection. Nothing here
authorises a production integration, and Garden Hub is not becoming a harness:
it would manage one.

Status: **capability axis measured; cost axis not measured** (the sandbox has no
provider network and no credentials). The split is deliberate and appears in
every table below.

## 1. What was actually run

Recorded 2026-11-23 on Darwin arm64. Versions are stored in
`tests/harness-evaluation/fixtures/versions.txt`:

```
codex-cli 0.135.0
2.1.330 (Claude Code)
v26.5.0
Darwin arm64
```

Three observations were recorded, not assumed:

1. **Codex app-server protocol surface.** `codex app-server
   generate-json-schema --out "$TMPDIR/schema"` produced a 39-file schema
   bundle. Its three method enums were reduced to
   `tests/harness-evaluation/fixtures/codex-app-server-methods.json`
   (client requests, server notifications, server requests) by
   `reduceSchemaBundle()` in `tools/harness-probe.mjs`. The three input schema
   files are committed under `fixtures/codex-app-server/`, so `CAP-007` repeats
   that reduction and compares it to the summary without `codex` installed.
2. **CLI surfaces.** `claude --help` and `codex exec --help` were captured
   verbatim to `fixtures/claude-code-help.txt` and
   `fixtures/codex-exec-help.txt`.
3. **Executability in this sandbox.** An offline attempt at each harness to
   establish whether the cost axis could be measured at all:

   ```
   $ claude -p "reply with ok" --output-format json
   {"type":"result","is_error":true,"result":"Not logged in · Please run /login",
    "usage":{...,"input_tokens":0,"output_tokens":0},"total_cost_usd":0}

   $ codex exec --skip-git-repo-check --json -s read-only "reply with ok"
   ERROR codex_api::endpoint::responses_websocket: failed to connect ...
     url: wss://api.openai.com/v1/responses
   {"type":"turn.failed","error":{"message":"stream disconnected ..."}}
   ```

   Both exits were non-fatal to the harness but produced **no model work**:
   zero tokens billed, no turn completed. That is the evidence for "cost not
   measured", and it is why the cost axis below has an empty measured column.

The capability matrix is recomputable without spending allowance:

```sh
node tools/harness-probe.mjs          # prints the matrix from the fixtures
node --test tests/harness-evaluation/harness-probe.test.mjs
```

## 2. Capability axis (measured)

Derived from the recorded surfaces by `tools/harness-probe.mjs`. `yes` means a
documented protocol method or flag exists; `partial` means the information
exists but not as a control; `host-dependent` means the harness can delegate but
does not itself answer.

| control            | Claude Code CLI (`-p` stream-json) | Codex app-server (JSON-RPC) | `codex exec` |
| ------------------ | ---------------------------------- | --------------------------- | ------------ |
| start-work         | yes                                | yes                         | yes          |
| tool-activity      | yes                                | yes                         | partial      |
| answer-question    | yes                                | yes                         | no           |
| approve-permission | host-dependent                     | yes                         | no           |
| interrupt          | yes                                | yes                         | no           |
| reconnect          | yes                                | yes                         | no           |
| show-changes       | partial                            | yes                         | partial      |

Evidence per cell is a named method or flag, held in the `evidence` field of
each row in `capabilityRows()`:

- **Codex app-server** covers the whole axis with first-class protocol methods:
  start (`thread/start`, `turn/start`), tool activity (`item/started`,
  `item/completed`, `item/commandExecution/outputDelta`), questions
  (`item/tool/requestUserInput`), permissions
  (`item/{commandExecution,fileChange,permissions}/requestApproval`), interrupt
  (`turn/interrupt`), reconnect (`thread/resume`), and changes
  (`turn/diff/updated`).
- **Claude Code `--print` + `--input-format/--output-format stream-json`**
  exposes the same controls as flags plus a control-stdin channel
  (`--session-id`/`--resume` for reconnect, `--include-partial-messages` for
  streaming). Its one gap is permission answering: `--print` alone denies
  anything that would prompt, and a per-call answer requires a host
  (`--permission-prompts host`, or `--permission-prompt-tool`). That is a
  property of the integration, not of the harness.
- **`codex exec`** is a batch runner. It streams items as JSONL and accepts
  `--output-schema`, but it has no resume of a live turn, no interrupt, no
  server-request channel for questions, and only a blanket
  `--dangerously-bypass-approvals-and-sandbox` instead of a per-call approval
  answer.

## 3. Cost axis (not measured)

No numbers are reported because none were observed. Reporting a token figure
here would be fabrication.

What *is* recorded, and is a mechanism rather than a measurement:

- The app-server reports usage per turn via
  `ServerNotification: thread/tokenUsage/updated`, with a
  `TokenUsageBreakdown` of `inputTokens`, `cachedInputTokens`,
  `outputTokens`, `reasoningOutputTokens`, `totalTokens`, plus a
  `modelContextWindow` and a `last`/`total` split
  (`ThreadTokenUsage` in the schema bundle). An integration can therefore read
  cost instead of inferring it.
- Claude Code's `--output-format json` result object carries a `usage` block
  and `total_cost_usd`, which is what the offline attempt above printed with
  zeros.

Both are **mechanisms for measuring cost later**. Neither shows that a
structured integration costs more or fewer tokens than the interactive client.
Claims of SDK overhead seen elsewhere are therefore not evidence for this
project, and are not repeated as findings here.

To fill this axis, run the same bounded task set on a networked, authenticated
host and record, per candidate: prompt tokens, cached input tokens, output
tokens, reasoning tokens, turn count, and elapsed time. The task set must fix
application prompts, background calls, session length, parallelism and human
intervention, as the issue requires.

## 4. Entitlement and native optimisation (not determined)

Model access, plan eligibility, prompt caching, tool-call repair and feedback
learning are properties of how a client authenticates and which route it uses.
They can only be settled by running under a real account. Nothing in this
evaluation establishes them either way, so no option is credited or debited
here. Treat this axis as open until the networked run above includes it.

## 5. Recommendation

1. **Do not pursue `codex exec` as the execution surface.** Measured: it fails
   five of seven controls, including every interactive one. It is the right
   tool for batch, non-interactive work and the wrong one for "handle a
   permission prompt, interrupt, reconnect".
2. **Keep the interactive CLI as the behavioural baseline, but not as the
   integration.** It is where the capability and cost reference values come
   from; it cannot itself be driven by a supervisor.
3. **The two viable candidates are the Codex app-server and Claude Code's
   structured stream-json mode.** Both are unmodified, native interfaces that
   cover the capability axis. The app-server covers it most completely and
   reports token usage as a protocol event; Claude Code's only real gap is that
   a permission answer must come from the host, which is exactly what Garden
   Hub would be.
4. **No execution service (for example T3 Code) was compared.** The issue bounds
   the POC to the installed runtimes, and choosing one would be follow-on work
   with its own intent. This is a gap in the evidence, not a verdict on that
   option.

The decision the evidence supports is *which interface to prototype against*,
not which runtime to adopt: prototype against **Codex app-server first**, with
Claude Code stream-json as the second candidate, and gate any production
integration on the cost and entitlement axes being measured on a networked,
authenticated host.

## 6. Measured vs external

| Claim | Kind |
| --- | --- |
| Codex app-server exposes the seven controls as named protocol methods | measured (schema bundle) |
| Claude Code advertises `--print`, stream-json in/out, `--resume`, `--session-id` | measured (`--help`) |
| `codex exec` has no interrupt, resume-of-live-turn, or per-call approval | measured (`--help`) |
| Both harnesses produced zero model work in this sandbox | measured (offline run) |
| Token cost of a structured integration vs the interactive client | **not measured** |
| SDK integrations have token overhead | external claim, not evaluated here |
| Entitlement/caching differences per route | **not determined** |
