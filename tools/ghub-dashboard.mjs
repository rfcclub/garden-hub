#!/usr/bin/env node
// ghub-dashboard - read-only dashboard for Garden Hub.
//
// A loopback-only HTTP server plus static assets in ../dashboard/. Every
// agent, project and repository name is an allowlist entry from a JSON
// configuration file (see README.md). Without configuration every value is a
// neutral label: "Other agent", "Other project", "Other repository",
// "Other event", "Other reason". Event payloads never cross the boundary.
//
// The work database path has no default. Set GHUB_WORK_DB; without it
// /api/works reports source "unavailable".
//
// Columns read from the works table:
//   repo TEXT, issue INTEGER, state TEXT, blocked_reason TEXT,
//   pr_url TEXT, updated_at TEXT
// Only rows with state = 'blocked' are read, newest updated_at first, one
// bounded keyset page at a time. A pull-request URL is returned only when it is
// https://github.com/<owner>/<name>/pull/<number> for a configured repository.

import { createServer } from 'node:http';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { pageEvents, storeDir } from './ghub-log.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DASHBOARD_DIR = join(ROOT, 'dashboard');

const NEUTRAL = {
  agent: 'Other agent',
  project: 'Other project',
  repository: 'Other repository',
  eventType: 'Other event',
  reason: 'Other reason',
};

const ASSETS = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
]);

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
    "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

const LOOPBACK_NAME = '(?:127\\.0\\.0\\.1|localhost|\\[::1\\])';
const HOST_PATTERN = new RegExp(`^${LOOPBACK_NAME}(?::[0-9]{1,5})?$`);
const ORIGIN_PATTERN = new RegExp(`^http://${LOOPBACK_NAME}(?::[0-9]{1,5})?$`);
const PAGE_LIMIT_PATTERN = /^(?:[1-9]|[1-9][0-9]|100)$/;
const CURSOR_PATTERN = /^[A-Za-z0-9_-]+$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

// --- configuration --------------------------------------------------------

function fail(message) {
  throw new Error(`dashboard configuration: ${message}`);
}

function stringList(value, field) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail(`${field} must be an array of strings`);
  const result = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.trim() === '') fail(`${field} must contain non-empty strings`);
    result.push(entry.trim());
  }
  return result;
}

function blockedReasonList(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail('blockedReasons must be an array');
  return value.map((entry) => {
    let pattern;
    let label;
    if (typeof entry === 'string') {
      pattern = entry;
      label = entry;
    } else if (entry && typeof entry === 'object' && typeof entry.pattern === 'string') {
      pattern = entry.pattern;
      label = typeof entry.label === 'string' && entry.label !== '' ? entry.label : entry.pattern;
    } else {
      fail('blockedReasons entries must be a pattern string or an object with a pattern');
    }
    try {
      // Keep the compiled expression reachable for the server.
      new RegExp(pattern); // eslint-disable-line no-new
    } catch {
      fail(`blockedReasons pattern is not a valid regular expression: ${pattern}`);
    }
    return { pattern, label };
  });
}

// Returns a plain, validated configuration object.
export function normalizeConfig(raw) {
  if (raw === undefined || raw === null) {
    return { agents: [], projects: [], repositories: [], eventTypes: [], blockedReasons: [] };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) fail('configuration must be an object');
  return {
    agents: stringList(raw.agents, 'agents'),
    projects: stringList(raw.projects, 'projects'),
    repositories: stringList(raw.repositories, 'repositories'),
    eventTypes: stringList(raw.eventTypes, 'eventTypes'),
    blockedReasons: blockedReasonList(raw.blockedReasons),
  };
}

export function loadConfigFile(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new Error('dashboard configuration: cannot read configuration file');
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('dashboard configuration: configuration file is not valid JSON');
  }
  const config = normalizeConfig(raw);
  for (const repository of config.repositories) {
    if (!REPOSITORY_PATTERN.test(repository)) {
      fail(`repositories entries must look like "owner/name": ${repository}`);
    }
  }
  return config;
}

function compileConfig(raw) {
  const config = normalizeConfig(raw);
  for (const repository of config.repositories) {
    if (!REPOSITORY_PATTERN.test(repository)) {
      fail(`repositories entries must look like "owner/name": ${repository}`);
    }
  }
  const lower = (list) => new Map(list.map((value) => [value.toLowerCase(), value]));
  return {
    agents: lower(config.agents),
    projects: lower(config.projects),
    repositories: config.repositories,
    repositoryLabels: lower(config.repositories),
    eventTypes: new Set(config.eventTypes),
    blockedReasons: config.blockedReasons.map(({ pattern, label }) => ({ regex: new RegExp(pattern), label })),
    // Every accepted pull-request URL is built from the repository allowlist.
    pullRequestPatterns: config.repositories.map(
      (repository) => new RegExp(`^https://github\\.com/${repository.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/pull/[0-9]+$`, 'i'),
    ),
  };
}

// --- sanitising -----------------------------------------------------------

function labelFor(value, allowed, neutral) {
  if (typeof value !== 'string') return neutral;
  const match = allowed.get(value.toLowerCase());
  return match === undefined ? neutral : match;
}

function safeEvent(event, config) {
  const parsedTs = typeof event.ts === 'string' ? Date.parse(event.ts) : NaN;
  return {
    ts: Number.isFinite(parsedTs) ? new Date(parsedTs).toISOString() : null,
    type: typeof event.type === 'string' && config.eventTypes.has(event.type) ? event.type : NEUTRAL.eventType,
    agent: labelFor(event.agent_id, config.agents, NEUTRAL.agent),
    project: labelFor(event.project, config.projects, NEUTRAL.project),
  };
}

function safeReason(value, config) {
  if (typeof value !== 'string') return NEUTRAL.reason;
  const matched = config.blockedReasons.find(({ regex }) => regex.test(value));
  return matched ? matched.label : NEUTRAL.reason;
}

function safePrUrl(value, config) {
  if (typeof value !== 'string') return null;
  return config.pullRequestPatterns.some((pattern) => pattern.test(value)) ? value : null;
}

// A works page is a keyset window ordered by (instant, issue, rowid): the
// instant is the numeric julianday of updated_at, so mixed offsets compare as
// times rather than as text, rows without a timestamp (or with an unparseable
// one) sort last, and rowid makes the key unique because an issue number
// repeats across repositories. Rows that appear at, or leave, the top of the
// queue between two pages neither shift the cursor nor produce duplicates. One
// extra row is read to learn whether a next page exists.
const WORKS_COLUMNS =
  'SELECT rowid AS work_rowid, repo, state, blocked_reason, pr_url, updated_at,' +
  ' julianday(updated_at) AS updated_jd,' +
  // An issue that is not a positive integer within the exactly representable
  // range sorts as 0, so every row has a comparable key and one odd row can
  // neither end the paging nor make the read fail on an out-of-range integer.
  " CASE WHEN typeof(issue) = 'integer' AND issue BETWEEN 1 AND 9007199254740991" +
  ' THEN issue ELSE 0 END AS sort_issue FROM works';
const WORKS_ORDER =
  'ORDER BY (updated_jd IS NULL), updated_jd DESC, sort_issue DESC, rowid DESC';

// Rows strictly after the cursor row in WORKS_ORDER. Rows without a usable
// instant come last, so every one of them is reachable once the cursor instant
// is set. Parameters are bound in WORKS_ORDER order.
function worksAfterCursor(after) {
  if (after.instant === null) {
    return {
      where: 'updated_jd IS NULL AND (sort_issue < ? OR (sort_issue = ? AND rowid < ?))',
      params: [after.issue, after.issue, after.rowid],
    };
  }
  return {
    where:
      '((updated_jd IS NOT NULL AND (updated_jd < ? OR (updated_jd = ? AND (sort_issue < ?' +
      ' OR (sort_issue = ? AND rowid < ?))))) OR updated_jd IS NULL)',
    params: [after.instant, after.instant, after.issue, after.issue, after.rowid],
  };
}

function readWorks(dbPath, config, { limit, after }) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const condition = after ? worksAfterCursor(after) : null;
    const statement = condition
      ? db.prepare(`${WORKS_COLUMNS} WHERE state = 'blocked' AND ${condition.where} ${WORKS_ORDER} LIMIT ?`)
      : db.prepare(`${WORKS_COLUMNS} WHERE state = 'blocked' ${WORKS_ORDER} LIMIT ?`);
    const rows = condition
      ? statement.all(...condition.params, limit + 1)
      : statement.all(limit + 1);
    const visible = rows.slice(0, limit);
    const works = visible.map((row) => {
      const updatedMs = typeof row.updated_at === 'string' ? Date.parse(row.updated_at) : NaN;
      return {
        repository: labelFor(row.repo, config.repositoryLabels, NEUTRAL.repository),
        issue: row.sort_issue > 0 ? row.sort_issue : null,
        state: 'blocked',
        reason: safeReason(row.blocked_reason, config),
        pr_url: safePrUrl(row.pr_url, config),
        updated_at: Number.isFinite(updatedMs) ? new Date(updatedMs).toISOString() : null,
      };
    });
    const last = visible[visible.length - 1];
    // The cursor must be a usable keyset: a row whose ordering values cannot be
    // compared ends the page rather than producing a cursor that the next
    // request would reject.
    const usable =
      last !== undefined &&
      Number.isSafeInteger(last.sort_issue) &&
      Number.isSafeInteger(last.work_rowid) &&
      (last.updated_jd === null || Number.isFinite(last.updated_jd));
    return {
      works,
      next: rows.length > limit && usable
        ? { instant: last.updated_jd ?? null, issue: last.sort_issue, rowid: last.work_rowid }
        : null,
    };
  } finally {
    db.close();
  }
}

// --- HTTP -----------------------------------------------------------------

function respond(res, status, type, body, extra = {}) {
  res.writeHead(status, { 'Content-Type': type, ...SECURITY_HEADERS, ...extra });
  res.end(body);
}

function json(res, status, value, extra) {
  respond(res, status, 'application/json; charset=utf-8', JSON.stringify(value), extra);
}

function pageParameter(searchParams) {
  const limitText = searchParams.get('limit') ?? '60';
  const cursor = searchParams.get('cursor');
  if (!PAGE_LIMIT_PATTERN.test(limitText)) return { error: true };
  if (cursor !== null && (cursor.length > 512 || !CURSOR_PATTERN.test(cursor))) return { error: true };
  return { limit: Number(limitText), cursor };
}

// The cursor carries only the ordering values of the last row shown, never a
// repository name, so a name that is neutralised in the payload is not leaked
// through the opaque cursor either.
function encodeWorksCursor(key) {
  return Buffer.from(
    JSON.stringify({ instant: key.instant, issue: key.issue, rowid: key.rowid }),
  ).toString('base64url');
}

function readWorksCursor(cursor) {
  if (cursor === null) return null;
  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  if (!decoded || typeof decoded !== 'object') return undefined;
  const instant = decoded.instant;
  if (instant !== null && (typeof instant !== 'number' || !Number.isFinite(instant))) return undefined;
  if (!Number.isSafeInteger(decoded.issue) || !Number.isSafeInteger(decoded.rowid)) return undefined;
  return { instant, issue: decoded.issue, rowid: decoded.rowid };
}

export function createDashboardServer(options = {}) {
  const { config: rawConfig, configPath, dbPath, eventsDir } = options;
  const config = compileConfig(configPath ? loadConfigFile(configPath) : rawConfig);
  const store = eventsDir ?? storeDir();

  return createServer((req, res) => {
    const host = req.headers.host;
    const origin = req.headers.origin;
    if (typeof host !== 'string' || !HOST_PATTERN.test(host)) {
      return json(res, 403, { error: 'Forbidden' });
    }
    if (origin !== undefined && !ORIGIN_PATTERN.test(origin)) {
      return json(res, 403, { error: 'Forbidden' });
    }
    if (req.method !== 'GET') {
      return json(res, 405, { error: 'Method not allowed' }, { Allow: 'GET' });
    }

    let url;
    try {
      url = new URL(req.url, 'http://127.0.0.1');
    } catch {
      return json(res, 400, { error: 'Invalid request' });
    }

    const asset = ASSETS.get(url.pathname);
    if (asset) {
      let body;
      try {
        body = readFileSync(join(DASHBOARD_DIR, asset[0]));
      } catch {
        return json(res, 503, { error: 'Dashboard assets unavailable' });
      }
      return respond(res, 200, asset[1], body);
    }

    if (url.pathname === '/api/events') {
      const page = pageParameter(url.searchParams);
      if (page.error) return json(res, 400, { error: 'Invalid page' });
      try {
        const result = pageEvents(store, { limit: page.limit, cursor: page.cursor });
        return json(res, 200, {
          source: 'available',
          events: result.events.map((event) => safeEvent(event, config)),
          next: result.cursor ?? null,
        });
      } catch (error) {
        if (error instanceof Error && error.message === 'invalid cursor') {
          return json(res, 400, { error: 'Invalid page' });
        }
        return json(res, 200, { source: 'unavailable', events: [], next: null });
      }
    }

    if (url.pathname === '/api/works') {
      const page = pageParameter(url.searchParams);
      if (page.error) return json(res, 400, { error: 'Invalid page' });
      const after = readWorksCursor(page.cursor);
      if (after === undefined) return json(res, 400, { error: 'Invalid page' });
      if (!dbPath) return json(res, 200, { source: 'unavailable', works: [] });
      let result;
      try {
        result = readWorks(dbPath, config, { limit: page.limit, after });
      } catch {
        return json(res, 200, { source: 'unavailable', works: [] });
      }
      return json(res, 200, {
        source: 'available',
        works: result.works,
        next: result.next ? encodeWorksCursor(result.next) : null,
      });
    }

    return json(res, 404, { error: 'Not found' });
  });
}

// --- CLI ------------------------------------------------------------------

let main = false;
try {
  main = realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
} catch {
  /* imported as a module */
}

if (main) {
  const portText = process.env.GHUB_DASHBOARD_PORT || '47820';
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error('Garden Hub dashboard: invalid port');
    process.exitCode = 1;
  } else {
    createDashboardServer({
      configPath: process.env.GHUB_DASHBOARD_CONFIG || undefined,
      dbPath: process.env.GHUB_WORK_DB || undefined,
    })
      .listen(port, '127.0.0.1', function ready() {
        console.log(`Garden Hub dashboard: http://127.0.0.1:${this.address().port}/`);
      })
      .on('error', () => {
        console.error('Garden Hub dashboard could not start on loopback');
        process.exitCode = 1;
      });
  }
}
