// ghub-log tests — TDD acceptance theo spec garden-hub-event-log
// Run: node --test tools/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, 'ghub-log.mjs');
const execFileAsync = promisify(execFile);

function newStore() {
  return mkdtempSync(join(tmpdir(), 'ghub-test-'));
}

function runCLI(args, storeDir) {
  return spawnSync(process.execPath, [CLI, ...args], {
    env: { ...process.env, GHUB_EVENTS_DIR: storeDir },
    encoding: 'utf8',
  });
}

function storeLines(storeDir) {
  return readdirSync(storeDir)
    .filter((f) => f.endsWith('.jsonl'))
    .flatMap((f) => readFileSync(join(storeDir, f), 'utf8').split('\n').filter(Boolean));
}

const TYPE_OK = 'TASK_CLAIMED';

test('roundtrip: emit 1 event -> tail returns it with all 10 fields', () => {
  const store = newStore();
  const r = runCLI(['emit', '--type', TYPE_OK, '--agent', 'agent-1', '--payload', '{"task":"x"}'], store);
  assert.equal(r.status, 0, r.stderr);
  const t = runCLI(['tail'], store);
  assert.equal(t.status, 0);
  const lines = t.stdout.trim().split('\n');
  assert.equal(lines.length, 1);
  const ev = JSON.parse(lines[0]);
  // 10 fields: 5 required + 5 optional (optional ones may be absent when not supplied)
  for (const k of ['event_id', 'ts', 'type', 'agent_id', 'payload']) {
    assert.ok(k in ev, `missing ${k}`);
  }
  assert.equal(ev.type, TYPE_OK);
  assert.equal(ev.agent_id, 'agent-1');
  assert.deepEqual(ev.payload, { task: 'x' });
  assert.equal(isNaN(Date.parse(ev.ts)), false);
  assert.match(ev.event_id, /^[0-9a-f-]{36}$/);
});

test('emit without a required field -> exit != 0, store unchanged', () => {
  const store = newStore();
  const r = runCLI(['emit', '--type', TYPE_OK, '--payload', '{}'], store); // no --agent
  assert.notEqual(r.status, 0);
  assert.equal(storeLines(store).length, 0);
});

test('emit with a bad type enum -> exit != 0, store unchanged', () => {
  const store = newStore();
  const r = runCLI(['emit', '--type', 'NOT_A_TYPE', '--agent', 'a', '--payload', '{}'], store);
  assert.notEqual(r.status, 0);
  assert.equal(storeLines(store).length, 0);
});

test('payload is not an object -> exit != 0', () => {
  const store = newStore();
  const r = runCLI(['emit', '--type', TYPE_OK, '--agent', 'a', '--payload', '"string"'], store);
  assert.notEqual(r.status, 0);
  assert.equal(storeLines(store).length, 0);
});

test('tail --agent filters correctly', () => {
  const store = newStore();
  runCLI(['emit', '--type', 'HEARTBEAT', '--agent', 'agent-1', '--payload', '{}'], store);
  runCLI(['emit', '--type', 'HEARTBEAT', '--agent', 'pulse', '--payload', '{}'], store);
  const t = runCLI(['tail', '--agent', 'agent-1'], store);
  const lines = t.stdout.trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).agent_id, 'agent-1');
});

test('rotation: emit in another month -> new file, old file untouched', () => {
  const store = newStore();
  runCLI(['emit', '--type', 'HEARTBEAT', '--agent', 'a', '--payload', '{}', '--ts', '2026-10-15T10:00:00Z'], store);
  const oldFile = join(store, 'events-2026-10.jsonl');
  assert.ok(existsSync(oldFile));
  const oldContent = readFileSync(oldFile, 'utf8');
  runCLI(['emit', '--type', 'HEARTBEAT', '--agent', 'a', '--payload', '{}', '--ts', '2026-11-01T10:00:00Z'], store);
  assert.ok(existsSync(join(store, 'events-2026-11.jsonl')));
  assert.equal(readFileSync(oldFile, 'utf8'), oldContent, 'old file was changed');
  assert.equal(storeLines(store).length, 2);
});

test('tail --since filters by time', () => {
  const store = newStore();
  runCLI(['emit', '--type', 'HEARTBEAT', '--agent', 'a', '--payload', '{}', '--ts', '2026-10-01T10:00:00Z'], store);
  runCLI(['emit', '--type', 'HEARTBEAT', '--agent', 'a', '--payload', '{}', '--ts', '2026-10-02T10:00:00Z'], store);
  const t = runCLI(['tail', '--since', '2026-10-02T00:00:00Z'], store);
  const lines = t.stdout.trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 1);
});

test('concurrent: 2 processes emit 100 events each -> 200 valid lines', async () => {
  const store = newStore();
  const childSrc = `
import { appendEvent, buildEvent } from ${JSON.stringify(pathToFileURL(CLI).href)};
const dir = process.argv[2];
const tag = process.argv[3];
for (let i = 0; i < 100; i++) {
  appendEvent(dir, buildEvent({ type: 'HEARTBEAT', agent: tag, payload: { i } }));
}
`;
  const childPath = join(store, 'child.mjs'); // an extra .mjs file in the store dir; it has no .jsonl suffix so it is ignored
  writeFileSync(childPath, childSrc);
  await Promise.all([
    execFileAsync(process.execPath, [childPath, store, 'p1']),
    execFileAsync(process.execPath, [childPath, store, 'p2']),
  ]);
  const lines = storeLines(store);
  assert.equal(lines.length, 200, `expect 200 lines, got ${lines.length}`);
  for (const l of lines) JSON.parse(l); // every line parses - none are fused
});
