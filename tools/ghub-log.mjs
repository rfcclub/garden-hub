#!/usr/bin/env node
// ghub-log - event log CLI for Garden Hub
// Zero-dependency Node. Store: JSONL append-only, one file per month (events-YYYY-MM.jsonl).
//
// Commands:
//   ghub-log emit --type <TYPE> --agent <id> [--payload '<json>'] [--ts <ISO>]
//                 [--runtime <r>] [--room <r>] [--project <p>] [--evidence <e>] [--confidence <n>]
//   ghub-log tail [--type <TYPE>] [--agent <id>] [--since <ISO>] [--limit <n>]
//
// Schema v1 - required: event_id, ts, type, agent_id, payload
//             optional: instance_id, runtime, room, project, evidence, confidence
// Event types v1:
//   SESSION_STARTED, SESSION_ENDED, HEARTBEAT, TASK_CLAIMED, TASK_COMPLETED,
//   BLOCKER_REPORTED, INSIGHT_PROPOSED, HANDOFF_WRITTEN

import { randomUUID } from 'node:crypto';
import { openSync, writeSync, readSync, fstatSync, statSync, realpathSync, readdirSync, readFileSync, mkdirSync, closeSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const EVENT_TYPES = [
  'SESSION_STARTED',
  'SESSION_ENDED',
  'HEARTBEAT',
  'TASK_CLAIMED',
  'TASK_COMPLETED',
  'BLOCKER_REPORTED',
  'INSIGHT_PROPOSED',
  'HANDOFF_WRITTEN',
];

const OPTIONAL_FIELDS = ['instance_id', 'runtime', 'room', 'project', 'evidence', 'confidence'];

export function storeDir() {
  return process.env.GHUB_EVENTS_DIR || join(dirname(fileURLToPath(import.meta.url)), '..', 'events');
}

// --- validation ---

// Returns an error string, or null when valid.
export function validateEvent(ev) {
  if (!ev || typeof ev !== 'object') return 'event must be an object';
  if (typeof ev.event_id !== 'string' || !/^[0-9a-f-]{36}$/.test(ev.event_id)) return 'event_id must be a uuid';
  if (typeof ev.ts !== 'string' || isNaN(Date.parse(ev.ts))) return 'ts must be a parseable ISO-8601 string';
  if (!EVENT_TYPES.includes(ev.type)) return `type "${ev.type}" is not in the enum (${EVENT_TYPES.join(', ')})`;
  if (typeof ev.agent_id !== 'string' || ev.agent_id.trim() === '') return 'agent_id must be a non-empty string';
  if (ev.payload === null || typeof ev.payload !== 'object' || Array.isArray(ev.payload)) {
    return 'payload must be an object';
  }
  for (const k of OPTIONAL_FIELDS) {
    if (k in ev && ev[k] === undefined) continue;
    if (k in ev && (typeof ev[k] !== 'string' && typeof ev[k] !== 'number')) return `${k} must be a string or a number`;
  }
  return null;
}

// Build a full event: event_id and ts are generated when not supplied.
export function buildEvent({ type, agent, agent_id, payload, ts, ...optional }) {
  const ev = {
    event_id: randomUUID(),
    ts: ts || new Date().toISOString(),
    type,
    agent_id: agent_id || agent,
    payload,
  };
  for (const k of OPTIONAL_FIELDS) {
    if (optional[k] !== undefined && optional[k] !== null && optional[k] !== '') ev[k] = optional[k];
  }
  return ev;
}

// --- append (atomic: one writeSync of one line through O_APPEND) ---

function monthFile(dir, ts) {
  const month = ts.slice(0, 7); // "2026-10"
  return join(dir, `events-${month}.jsonl`);
}

export function appendEvent(dir, ev) {
  const err = validateEvent(ev);
  if (err) throw new Error(`invalid event: ${err}`);
  mkdirSync(dir, { recursive: true });
  const file = monthFile(dir, ev.ts);
  const line = JSON.stringify(ev) + '\n';
  const fd = openSync(file, 'a'); // O_APPEND: each writeSync is one atomic append
  try {
    writeSyncAll(fd, line);
  } finally {
    closeSync(fd);
  }
  return file;
}

function writeSyncAll(fd, str) {
  const buf = Buffer.from(str, 'utf8');
  let written = 0;
  while (written < buf.length) {
    written += writeSync(fd, buf, written);
  }
}

// --- read / tail ---

export function readEvents(dir) {
  let files = [];
  try {
    files = readdirSync(dir).filter((f) => /^events-\d{4}-\d{2}\.jsonl$/.test(f)).sort();
  } catch {
    return []; // store does not exist yet
  }
  const events = [];
  for (const f of files) {
    const content = readFileSync(join(dir, f), 'utf8');
    for (const line of content.split('\n')) {
      if (!line) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        // corrupt line - skipped on read (append-only: it cannot be repaired, only noted)
      }
    }
  }
  return events;
}

export function tailEvents(dir, { type, agent, since, limit = 20 } = {}) {
  let events = readEvents(dir);
  if (type) events = events.filter((e) => e.type === type);
  if (agent) events = events.filter((e) => e.agent_id === agent);
  if (since) {
    const sinceMs = Date.parse(since);
    if (isNaN(sinceMs)) throw new Error('--since must be ISO-8601');
    events = events.filter((e) => Date.parse(e.ts) >= sinceMs);
  }
  return events.slice(-limit);
}

// Read bounded pages from recently modified monthly files, newest records
// first within each file. The cursor is a file/byte position, never content.
export function pageEvents(dir, { limit = 50, cursor = null, maxBytes = 65536, chunkBytes = 4096, maxLineBytes = 4096 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 ||
      !Number.isInteger(maxBytes) || maxBytes < 1 ||
      !Number.isInteger(chunkBytes) || chunkBytes < 1 ||
      !Number.isInteger(maxLineBytes) || maxLineBytes < 1) throw new Error('invalid page options');
  const files = readdirSync(dir)
    .filter(f => /^events-\d{4}-\d{2}\.jsonl$/.test(f))
    .map(file => ({ file, modified: statSync(join(dir, file), { bigint: true }).mtimeNs }))
    .sort((a, b) => a.modified === b.modified ? b.file.localeCompare(a.file) : a.modified > b.modified ? -1 : 1)
    .map(({ file }) => file);
  let position = null;
  if (cursor) {
    try { position = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); }
    catch { throw new Error('invalid cursor'); }
    if (!position || !files.includes(position.file) || !Number.isSafeInteger(position.offset) ||
        position.offset < 0 || (position.skip !== undefined && typeof position.skip !== 'boolean')) throw new Error('invalid cursor');
  }
  const encode = (file, offset, skip = false) => Buffer.from(JSON.stringify({ file, offset, skip })).toString('base64url');
  let scannedBytes = 0;
  const events = [];
  const startIndex = position ? files.indexOf(position.file) : 0;
  for (let fi = startIndex; fi < files.length; fi++) {
    const file = files[fi];
    const fd = openSync(join(dir, file), 'r');
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile()) continue;
      let pos = position && fi === startIndex ? position.offset : stat.size;
      if (pos > stat.size) throw new Error('invalid cursor');
      let skip = Boolean(position && fi === startIndex && position.skip);
      // Every ordinary cursor points just after a line delimiter. At a file
      // boundary it can also point at an unterminated tail, which must be
      // discarded exactly as it would be on the first page.
      let firstByte = !skip;
      let bytes = [];
      let lineEnd = pos;
      const takeLine = () => {
        if (!skip && bytes.length) {
          try {
            const parsed = JSON.parse(Buffer.from(bytes.reverse()).toString('utf8'));
            if (!validateEvent(parsed)) events.push(parsed);
          } catch { /* A malformed record cannot stop the rest of a page. */ }
        }
        bytes = [];
        skip = false;
      };
      while (pos > 0 && scannedBytes < maxBytes && events.length < limit) {
        const n = Math.min(pos, chunkBytes, maxBytes - scannedBytes);
        const block = Buffer.allocUnsafe(n);
        const read = readSync(fd, block, 0, n, pos - n);
        if (read !== n) throw new Error('event file changed while reading');
        scannedBytes += n;
        for (let i = n - 1; i >= 0; i--) {
          const byte = block[i];
          pos--;
          if (firstByte) {
            firstByte = false;
            // A record not yet terminated by a newline may still be in flight.
            if (byte !== 10) skip = true;
          }
          if (byte === 10) {
            if (bytes.length || skip) takeLine();
            lineEnd = pos + 1;
            if (events.length >= limit) return { events, cursor: encode(file, pos + 1), scannedBytes };
          } else if (!skip) {
            bytes.push(byte);
            if (bytes.length > maxLineBytes) { bytes = []; skip = true; }
          }
        }
      }
      if (pos === 0) {
        takeLine();
        if (events.length >= limit && fi + 1 < files.length) {
          const next = files[fi + 1];
          const nextFd = openSync(join(dir, next), 'r');
          try { return { events, cursor: encode(next, fstatSync(nextFd).size), scannedBytes }; }
          finally { closeSync(nextFd); }
        }
      } else {
        // Retry a short partial line at its boundary on the next page. If it
        // cannot fit in the budget, skip it incrementally to guarantee progress.
        const retry = !skip && lineEnd - pos < maxBytes;
        return { events, cursor: encode(file, retry ? lineEnd : pos, !retry && (skip || bytes.length > 0)), scannedBytes };
      }
      position = null;
    } finally {
      closeSync(fd);
    }
    if (scannedBytes >= maxBytes && fi + 1 < files.length) {
      const next = files[fi + 1];
      const nextFd = openSync(join(dir, next), 'r');
      try { return { events, cursor: encode(next, fstatSync(nextFd).size), scannedBytes }; }
      finally { closeSync(nextFd); }
    }
  }
  return { events, cursor: null, scannedBytes };
}

// --- CLI ---

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        i++;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function die(msg) {
  console.error(`ghub-log: ${msg}`);
  process.exit(1);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  const dir = storeDir();

  if (cmd === 'emit') {
    let payload;
    if (args.payload !== undefined) {
      try {
        payload = JSON.parse(args.payload);
      } catch {
        die('--payload must be valid JSON');
      }
    } else {
      payload = {};
    }
    const ev = buildEvent({
      type: args.type,
      agent: args.agent,
      payload,
      ts: args.ts,
      instance_id: args['instance-id'],
      runtime: args.runtime,
      room: args.room,
      project: args.project,
      evidence: args.evidence,
      confidence: args.confidence,
    });
    const err = validateEvent(ev);
    if (err) die(err);
    const file = appendEvent(dir, ev);
    console.log(ev.event_id);
    if (process.env.GHUB_QUIET !== '1') console.error(`→ ${basename(file)}`);
    return;
  }

  if (cmd === 'tail') {
    const events = tailEvents(dir, {
      type: args.type,
      agent: args.agent,
      since: args.since,
      limit: args.limit ? parseInt(args.limit, 10) : 20,
    });
    for (const e of events) console.log(JSON.stringify(e));
    return;
  }

  die(`unknown command: "${cmd || ''}". Use: emit | tail`);
}

// Run the CLI only when invoked directly (not when imported by a test).
// Compare realpaths so a symlinked invocation also works.
function isMainInvocation() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if (isMainInvocation()) main();
