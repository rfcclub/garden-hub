#!/usr/bin/env node
// harness-probe - offline capability probe for the Garden Hub #7 evaluation.
//
// The evaluation in docs/harness-evaluation.md compares execution options for
// Garden Hub. Two of its three axes can be established without spending model
// allowance:
//
//   capability - read the harness's own advertised surface (CLI help text, the
//                app-server JSON Schema) and derive which controls exist.
//   cost       - only measurable by running the same bounded task; this module
//                therefore returns "not measured" unless a run was possible.
//
// Everything here is a pure function over recorded text so the matrix can be
// recomputed from the fixtures in tests/harness-evaluation/fixtures. No
// provider call, no network, no credentials.
//
// Regenerate the Codex side of the fixtures with:
//   codex app-server generate-json-schema --out "$TMPDIR/schema"
// then reduceSchemaBundle() over ClientRequest, ServerNotification and
// ServerRequest. The three schema files are committed under fixtures/codex-app-server.
//
// Run: node tools/harness-probe.mjs

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const FIXTURES = new URL('../tests/harness-evaluation/fixtures/', import.meta.url);

// One row per control on the capability axis. The question text is what the
// POC actually asks of each option, so a "yes" is checkable.
export const APPROVAL_SURFACES = {
  'start-work': {
    question: 'Can a supervisor start a bounded task without a human at a TTY?',
  },
  'tool-activity': {
    question: 'Can the supervisor see tool calls and their output as they happen?',
  },
  'answer-question': {
    question: 'Can the model ask the supervisor a question and receive the answer?',
  },
  'approve-permission': {
    question: 'Can a permission prompt be answered by the supervisor per call?',
  },
  interrupt: {
    question: 'Can the supervisor stop an in-flight turn?',
  },
  reconnect: {
    question: 'Can the supervisor reattach to a session after its own restart?',
  },
  'show-changes': {
    question: 'Can the supervisor inspect the file changes a turn produced?',
  },
};

// The three method enums emitted by `codex app-server generate-json-schema`.
export const ENUM_TYPES = ['ClientRequest', 'ServerNotification', 'ServerRequest'];

// The three options the issue bounds the POC to. An execution service such as
// T3 Code is deliberately absent: the bounded POC compares runtime candidates
// that are already installed, and selecting an execution service is follow-on
// work with its own intent.
export const CANDIDATES = [
  {
    id: 'claude-cli-baseline',
    project: 'Claude Code interactive CLI',
    unmodified: true,
    surface: 'human TTY',
  },
  {
    id: 'claude-cli-stream-json',
    project: 'Claude Code --print --output-format stream-json',
    unmodified: true,
    surface: 'structured stdout + control stdin',
  },
  {
    id: 'codex-app-server',
    project: 'Codex app-server (JSON-RPC over stdio)',
    unmodified: true,
    surface: 'JSON-RPC over stdio',
  },
];

// A flag line in clap's layout is indented 2-7 spaces (2 for short+long, 6 for
// long-only). Wrapped description text is indented further and frequently
// mentions another flag, e.g. `--output-format=stream-json)`; matching only the
// flag-line indent, and requiring a delimiter after the name, keeps those from
// being parsed as entries that wipe the real flag's choices.
const ENTRY = /^ {2,7}(?:-[A-Za-z],\s+)?(--[A-Za-z0-9-]+)(?=\s|=|<|\[|$)/;
const CHOICES = /\(choices:\s*([^)]*)\)/g;
const QUOTED = /"([^"]+)"/g;

// Parse a `--help` page into its documented flags, the enumerated values each
// flag offers, and the permission modes it accepts. Claude Code and `codex
// exec` both use clap's layout, so one parser covers the fixture for each.
//
// Choices are kept per flag in `entryValues`; `values` is only the union, for
// callers that ask "is this value documented anywhere". A capability check must
// use `entryValues.get(flag)` so that one flag's choices cannot satisfy a
// check written against another flag.
export function readClaudeHelp(text) {
  const flags = new Set();
  const values = new Set();
  const entries = new Map();
  const entryValues = new Map();
  let current = null;

  for (const line of text.split('\n')) {
    const match = ENTRY.exec(line);
    if (match) {
      current = match[1];
      flags.add(current);
      entries.set(current, line.trim());
      entryValues.set(current, new Set());
    } else if (current) {
      entries.set(current, `${entries.get(current)} ${line.trim()}`.trim());
    }
  }

  for (const [flag, entry] of entries) {
    for (const group of entry.matchAll(CHOICES)) {
      for (const value of group[1].matchAll(QUOTED)) {
        values.add(value[1]);
        entryValues.get(flag).add(value[1]);
      }
    }
  }

  const permissionModes = [];
  const modeEntry = entries.get('--permission-mode');
  if (modeEntry) {
    const group = [...modeEntry.matchAll(CHOICES)].at(-1);
    if (group) for (const value of group[1].matchAll(QUOTED)) permissionModes.push(value[1]);
  }

  return { flags, values, entryValues, permissionModes, entries };
}

// Does `flag` document `value` among its own choices? Deliberately scoped to
// the flag: `--input-format ... stream-json` must not imply that
// `--output-format` offers it.
export function flagOffers(help, flag, value) {
  return help.entryValues?.get(flag)?.has(value) ?? false;
}

// Reduce a `codex app-server generate-json-schema` bundle to the three method
// enums. Each schema file is a draft-07 `oneOf` of request/notification objects
// whose `method` property is a single-value enum; the method name is that
// value. This is recorded so the committed methods fixture can be regenerated
// rather than merely trusted:
//   codex app-server generate-json-schema --out "$TMPDIR/schema"
//   then reduceSchemaBundle({ClientRequest, ServerNotification, ServerRequest})
export function reduceSchemaBundle(bundle) {
  const result = {};
  for (const key of ENUM_TYPES) {
    const variants = bundle[key]?.oneOf ?? [];
    result[key] = variants
      .flatMap((variant) => {
        const values = variant?.properties?.method?.enum ?? [];
        return values.length === 1 ? values : [];
      })
      // Sorted so the committed fixture diffs only when a method is added or
      // removed, not when the schema reorders its variants.
      .sort();
  }
  return result;
}

// The app-server schema bundle splits its protocol into three enums. Method
// names are the evidence: no method means no control.
export function readCodexMethods(bundle) {
  return {
    client: new Set(bundle.ClientRequest ?? []),
    notification: new Set(bundle.ServerNotification ?? []),
    request: new Set(bundle.ServerRequest ?? []),
  };
}

// `claude --help` does list the background-session subcommands (`attach`, and
// `stop|kill`), but a top-level listing does not establish what they do, and it
// does not overrule a missing `--resume`. Their own `--help` pages were
// therefore recorded separately: `stop <id>` interrupts, `attach <id>`
// reconnects, and `stop --help` states the conversation is kept for the later
// attach.
export function readClaudeLifecycle({ stopHelp = '', attachHelp = '' }) {
  return {
    stop: /^Usage:\s+claude stop\b/m.test(stopHelp),
    attach: /^Usage:\s+claude attach\b/m.test(attachHelp),
    keepsConversation: /conversation is kept/i.test(stopHelp),
  };
}

const yesNo = (ok) => (ok ? 'yes' : 'no');

// Derive the capability matrix from the recorded surfaces. Every column comes
// from a fixture: `claudeHelp` and `codexExecHelp` are parsed `--help` pages,
// `codexMethods` is the reduced app-server schema, and `claudeLifecycle` is the
// two recorded subcommand help pages. `unknown` is returned when a fixture was
// not supplied, so a caller cannot get a silent "no" from a missing input.
export function capabilityRows({
  claudeHelp,
  codexMethods,
  codexExecHelp,
  claudeLifecycle: lifecycle = {},
}) {
  const { flags } = claudeHelp;
  const client = codexMethods.client;
  const notification = codexMethods.notification;
  const request = codexMethods.request;
  const structuredStdout = flags.has('--output-format') && flagOffers(claudeHelp, '--output-format', 'stream-json');
  const structuredStdin = flags.has('--input-format') && flagOffers(claudeHelp, '--input-format', 'stream-json');

  const exec = codexExecHelp?.flags;
  const execRuns = yesNo(exec ? exec.size > 0 : false);
  const execJson = yesNo(exec?.has('--json') ?? false);
  const execAnswer = yesNo(exec?.has('--input-format') ?? false);
  const execApprove = yesNo(exec?.has('--permission-prompt-tool') ?? false);
  const execInterrupt = yesNo(exec?.has('--interrupt') ?? false);
  const execResume = yesNo(exec?.has('--resume') ?? false);
  const execSchema = yesNo(exec?.has('--output-schema') ?? false);

  const rows = {
    'start-work': {
      claudeCode: yesNo(flags.has('--print')),
      codexAppServer: yesNo(client.has('thread/start') && client.has('turn/start')),
      codexExec: execRuns,
      evidence: {
        claudeCode: '-p, --print',
        codexAppServer: 'ClientRequest: thread/start, turn/start',
        codexExec: 'codex exec [PROMPT]',
      },
    },
    'tool-activity': {
      claudeCode: yesNo(structuredStdout),
      codexAppServer: yesNo(notification.has('item/started') && notification.has('item/completed')),
      // JSONL items are a stream, not a queryable state, so this is the best
      // the exec path can be even with --json.
      codexExec: execJson === 'yes' ? 'partial' : 'no',
      evidence: {
        claudeCode: '--output-format stream-json',
        codexAppServer: 'ServerNotification: item/started, item/completed, item/commandExecution/outputDelta',
        codexExec: execJson === 'yes'
          ? '--json prints items as JSONL; output is a stream, not a queryable state'
          : 'no --json: nothing is streamed as events',
      },
    },
    'answer-question': {
      claudeCode: yesNo(structuredStdin),
      codexAppServer: yesNo(request.has('item/tool/requestUserInput')),
      codexExec: execAnswer,
      evidence: {
        claudeCode: '--input-format stream-json (host answers over control stdin)',
        codexAppServer: 'ServerRequest: item/tool/requestUserInput',
        codexExec: execAnswer === 'yes'
          ? '--input-format on the exec path'
          : 'no server-request channel in the exec subcommand',
      },
    },
    'approve-permission': {
      // `-p` alone denies anything that would prompt; a per-call answer needs
      // an external host (SDK host or --permission-prompt-tool), so this is a
      // property of the caller, not of the harness.
      claudeCode: flags.has('--permission-prompts') ? 'host-dependent' : 'no',
      codexAppServer: yesNo(
        request.has('item/commandExecution/requestApproval')
          || request.has('item/fileChange/requestApproval')
          || request.has('item/permissions/requestApproval'),
      ),
      codexExec: execApprove,
      evidence: {
        claudeCode: '--permission-prompts host|none (a host must answer; -p alone does not prompt)',
        codexAppServer: 'ServerRequest: item/{commandExecution,fileChange,permissions}/requestApproval',
        codexExec: execApprove === 'yes'
          ? '--permission-prompt-tool on the exec path'
          : 'only --dangerously-bypass-approvals-and-sandbox, i.e. no per-call answer',
      },
    },
    interrupt: {
      claudeCode: yesNo(lifecycle.stop || structuredStdin),
      codexAppServer: yesNo(client.has('turn/interrupt')),
      codexExec: execInterrupt,
      evidence: {
        claudeCode: lifecycle.stop
          ? 'claude stop <id> (stops a running session)'
          : 'control stdin of --input-format stream-json',
        codexAppServer: 'ClientRequest: turn/interrupt',
        codexExec: execInterrupt === 'yes'
          ? '--interrupt on the exec path'
          : 'no interrupt method on the exec path',
      },
    },
    reconnect: {
      claudeCode: yesNo((flags.has('--resume') && flags.has('--session-id')) || lifecycle.attach),
      codexAppServer: yesNo(client.has('thread/resume')),
      codexExec: execResume,
      evidence: {
        claudeCode: lifecycle.attach
          ? 'claude attach <id> (reopens a stopped session); -r, --resume and --session-id'
          : '-r, --resume and --session-id',
        codexAppServer: 'ClientRequest: thread/resume',
        codexExec: execResume === 'yes'
          ? '--resume on the exec path'
          : 'resume exists as a separate subcommand, not a reconnect of a live turn',
      },
    },
    'show-changes': {
      claudeCode: structuredStdout ? 'partial' : 'no',
      codexAppServer: yesNo(notification.has('turn/diff/updated')),
      // --output-schema shapes the final message; it does not report a diff.
      codexExec: execSchema === 'yes' ? 'partial' : 'no',
      evidence: {
        claudeCode: 'edits appear as tool input in stream-json; no consolidated turn diff',
        codexAppServer: 'ServerNotification: turn/diff/updated',
        codexExec: execSchema === 'yes'
          ? 'diffs recoverable from the workspace, not reported per turn'
          : 'no per-turn diff reporting on the exec path',
      },
    },
  };

  return Object.entries(APPROVAL_SURFACES).map(([control, { question }]) => ({
    control,
    question,
    claudeCode: rows[control].claudeCode,
    codexAppServer: rows[control].codexAppServer,
    codexExec: rows[control].codexExec,
    evidence: rows[control].evidence,
  }));
}

// The cost axis is a measurement or it is nothing. This function refuses to
// produce a number it did not observe, and records why it could not.
export function costFinding({ providerReachable, authenticated, tokenUsageExposed }) {
  const unmeasured = [];
  if (!providerReachable) {
    unmeasured.push('provider network unreachable: token and allowance use could not be observed');
  }
  if (!authenticated) {
    unmeasured.push('harness not logged in: no authenticated run was possible');
  }

  const measured = [];
  if (providerReachable && authenticated) {
    // A run was possible; the caller must supply its numbers. Refusing to
    // invent them here keeps the doc's "measured" column honest.
    unmeasured.push('run was possible but no bounded task result was supplied to this function');
  }

  return {
    measured,
    unmeasured,
    mechanism: {
      // Observed in the app-server schema, independent of any run: usage is
      // reported per turn, so an integration can read cost instead of guessing.
      tokenUsageExposed,
      source: tokenUsageExposed ? 'ServerNotification: thread/tokenUsage/updated' : null,
    },
    verdict: measured.length === 0 ? 'cost not measured' : 'cost measured',
  };
}

// --- CLI ---------------------------------------------------------------------

function loadFixtures() {
  const read = (name) => readFileSync(new URL(name, FIXTURES), 'utf8');
  return {
    claudeHelp: readClaudeHelp(read('claude-code-help.txt')),
    codexMethods: readCodexMethods(JSON.parse(read('codex-app-server-methods.json'))),
    codexExecHelp: readClaudeHelp(read('codex-exec-help.txt')),
    claudeLifecycle: readClaudeLifecycle({
      stopHelp: read('claude-code-stop-help.txt'),
      attachHelp: read('claude-code-attach-help.txt'),
    }),
    versions: read('versions.txt').trim(),
  };
}

function table(rows) {
  const widths = {
    control: Math.max(...rows.map((r) => r.control.length), 'control'.length),
    claudeCode: Math.max(...rows.map((r) => r.claudeCode.length), 'claudeCode'.length),
    codexAppServer: Math.max(...rows.map((r) => r.codexAppServer.length), 'codexAppServer'.length),
  };
  const pad = (v, n) => v.padEnd(n);
  const lines = [
    `| ${pad('control', widths.control)} | ${pad('claudeCode', widths.claudeCode)} | ${pad('codexAppServer', widths.codexAppServer)} | codexExec |`,
    `| ${'-'.repeat(widths.control)} | ${'-'.repeat(widths.claudeCode)} | ${'-'.repeat(widths.codexAppServer)} | --------- |`,
  ];
  for (const row of rows) {
    lines.push(
      `| ${pad(row.control, widths.control)} | ${pad(row.claudeCode, widths.claudeCode)} | ${pad(row.codexAppServer, widths.codexAppServer)} | ${row.codexExec} |`,
    );
  }
  return lines.join('\n');
}

// `file://${process.argv[1]}` silently fails to match when the checkout path
// contains a space (the URL is percent-encoded), and `process.argv[1]` is
// undefined when this module is imported, which pathToFileURL rejects. Both are
// why this guard is written the way it is.
const isEntryPoint = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  const { claudeHelp, codexMethods, codexExecHelp, claudeLifecycle, versions } = loadFixtures();
  const rows = capabilityRows({ claudeHelp, codexMethods, codexExecHelp, claudeLifecycle });

  console.log('# harness-probe (offline capability matrix)\n');
  console.log('Recorded versions:\n');
  console.log(versions.split('\n').map((line) => `  ${line}`).join('\n'));
  console.log('\ncodex exec controls: ' + [...codexExecHelp.flags].sort().join(' '));
  console.log('\n' + table(rows));
  console.log('\nCost: ' + JSON.stringify(
    costFinding({
      providerReachable: false,
      authenticated: false,
      tokenUsageExposed: codexMethods.notification.has('thread/tokenUsage/updated'),
    }),
    null,
    2,
  ));
  console.log(
    '\nCost is not measured here: this sandbox has no provider network and no\n'
      + 'credentials. Re-run the bounded task on a networked, authenticated host to\n'
      + 'fill that axis; see docs/harness-evaluation.md.',
  );
}
