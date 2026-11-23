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
// Only rows with state = 'blocked' are read, newest updated_at first.

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

const DEFAULT_QUEUE_STALE_SECONDS = 3600;

// Patterns that decide which blocked work is owner-actionable. `state =
// 'blocked'` alone never promotes a row into an owner-action requirement.
function ownerActionableList(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail('ownerActionable must be an array of regular expressions');
  return value.map((pattern) => {
    if (typeof pattern !== 'string' || pattern.trim() === '') {
      fail('ownerActionable must contain non-empty regular expressions');
    }
    try {
      new RegExp(pattern); // eslint-disable-line no-new
    } catch {
      fail(`ownerActionable pattern is not a valid regular expression: ${pattern}`);
    }
    return pattern;
  });
}

function queueStaleAfterSeconds(value) {
  if (value === undefined) return DEFAULT_QUEUE_STALE_SECONDS;
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail('queueStaleAfterSeconds must be a positive whole number of seconds');
  }
  return value;
}

// Returns a plain, validated configuration object.
export function normalizeConfig(raw) {
  if (raw === undefined || raw === null) {
    return {
      agents: [],
      projects: [],
      repositories: [],
      eventTypes: [],
      blockedReasons: [],
      ownerActionable: [],
      queueStaleAfterSeconds: DEFAULT_QUEUE_STALE_SECONDS,
    };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) fail('configuration must be an object');
  return {
    agents: stringList(raw.agents, 'agents'),
    projects: stringList(raw.projects, 'projects'),
    repositories: stringList(raw.repositories, 'repositories'),
    eventTypes: stringList(raw.eventTypes, 'eventTypes'),
    blockedReasons: blockedReasonList(raw.blockedReasons),
    ownerActionable: ownerActionableList(raw.ownerActionable),
    queueStaleAfterSeconds: queueStaleAfterSeconds(raw.queueStaleAfterSeconds),
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
    // A blocked row is owner-actionable only when one configured rule matches.
    ownerActionable: config.ownerActionable.map((pattern) => new RegExp(pattern)),
    ownerActionableConfigured: config.ownerActionable.length > 0,
    queueStaleAfterSeconds: config.queueStaleAfterSeconds,
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

function readWorks(dbPath, config) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db
      .prepare(
        'SELECT repo, issue, state, blocked_reason, pr_url, updated_at FROM works' +
          " WHERE state = 'blocked' ORDER BY updated_at DESC LIMIT 100",
      )
      .all();
    return rows.map((row) => {
      const updatedMs = typeof row.updated_at === 'string' ? Date.parse(row.updated_at) : NaN;
      return {
        repository: labelFor(row.repo, config.repositoryLabels, NEUTRAL.repository),
        issue: Number.isSafeInteger(row.issue) && row.issue > 0 ? row.issue : null,
        state: 'blocked',
        reason: safeReason(row.blocked_reason, config),
        pr_url: safePrUrl(row.pr_url, config),
        updated_at: Number.isFinite(updatedMs) ? new Date(updatedMs).toISOString() : null,
      };
    });
  } finally {
    db.close();
  }
}

// --- needs-the-owner queue ------------------------------------------------

const QUEUE_LIMIT = 100;
const DEFERRED_CATEGORIES = [
  { id: 'pending-approvals', label: 'Pending intent approvals' },
  { id: 'pending-confirmations', label: 'Pending confirmations' },
  { id: 'pending-escalations', label: 'Pending escalations' },
  { id: 'provider-quota', label: 'Provider quota near a ceiling' },
  { id: 'unreachable-machines', label: 'Unreachable machines' },
];

function issueLink(repository, issue) {
  // Built from an allowlisted repository and a positive integer, never from
  // stored text.
  if (!REPOSITORY_PATTERN.test(repository) || !Number.isSafeInteger(issue) || issue <= 0) return null;
  return { href: `https://github.com/${repository}/issues/${issue}`, label: 'Issue', kind: 'issue' };
}

function queueItem(row, config, nowMs) {
  const updatedMs = typeof row.updated_at === 'string' ? Date.parse(row.updated_at) : NaN;
  const observedMs = Number.isFinite(updatedMs) ? updatedMs : null;
  const ageSeconds = observedMs === null ? null : Math.max(0, Math.round((nowMs - observedMs) / 1000));
  return {
    id: `works:${row.repo}:${row.issue}`,
    source: 'works',
    category: 'blocked-work',
    repository: row.repo,
    issue: row.issue,
    description: safeReason(row.blocked_reason, config),
    observed_at: observedMs === null ? null : new Date(observedMs).toISOString(),
    age_seconds: ageSeconds,
    age_meaning: 'source-updated',
    first_seen: null,
    provenance: 'ownerActionable rule on works.blocked_reason',
    link: safePrUrl(row.pr_url, config)
      ? { href: safePrUrl(row.pr_url, config), label: 'Pull request', kind: 'pull-request' }
      : issueLink(row.repo, row.issue),
    stale: ageSeconds === null ? true : ageSeconds > config.queueStaleAfterSeconds,
  };
}

// Reads blocked work, keeps only rows an explicit configured rule marks
// owner-actionable, and reports its own freshness, truncation and failures.
function readQueueCategory(dbPath, config, nowMs) {
  const base = {
    id: 'blocked-work',
    label: 'Blocked work',
    source: 'works',
    resolved_when: 'works.state leaves blocked or the ownerActionable rule stops matching',
    limit: QUEUE_LIMIT,
  };
  if (!config.ownerActionableConfigured) {
    return { ...base, status: 'rule-missing', rule_configured: false, complete: false, truncated: false, stale_items: 0, items: [] };
  }
  if (!dbPath) {
    return { ...base, status: 'unavailable', rule_configured: true, complete: false, truncated: false, stale_items: 0, items: [] };
  }
  let rows;
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      rows = db
        .prepare(
          'SELECT repo, issue, state, blocked_reason, pr_url, updated_at FROM works' +
            " WHERE state = 'blocked' ORDER BY updated_at DESC LIMIT ?",
        )
        .all(QUEUE_LIMIT + 1);
    } finally {
      db.close();
    }
  } catch {
    return { ...base, status: 'unavailable', rule_configured: true, complete: false, truncated: false, stale_items: 0, items: [] };
  }

  const truncated = rows.length > QUEUE_LIMIT;
  const allowedRepositories = new Set(config.repositories);
  const items = [];
  for (const row of rows.slice(0, QUEUE_LIMIT)) {
    if (!allowedRepositories.has(row.repo)) continue;
    if (!Number.isSafeInteger(row.issue) || row.issue <= 0) continue;
    if (typeof row.blocked_reason !== 'string') continue;
    if (!config.ownerActionable.some((regex) => regex.test(row.blocked_reason))) continue;
    items.push(queueItem(row, config, nowMs));
  }
  // Triage order: observations with no readable time first (their age is
  // unknown), then the oldest observation first. Ties keep source order.
  items.sort((a, b) => {
    if (a.age_seconds === null && b.age_seconds !== null) return -1;
    if (b.age_seconds === null && a.age_seconds !== null) return 1;
    if (a.age_seconds === null) return 0;
    return b.age_seconds - a.age_seconds;
  });
  const staleItems = items.filter((item) => item.stale).length;
  return {
    ...base,
    status: truncated ? 'truncated' : 'ok',
    rule_configured: true,
    complete: !truncated,
    truncated,
    stale_items: staleItems,
    items,
  };
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

function readWorksCursor(cursor) {
  if (cursor === null) return 0;
  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!decoded || !Number.isSafeInteger(decoded.offset) || decoded.offset < 0) return null;
  return decoded.offset;
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
      const offset = readWorksCursor(page.cursor);
      if (offset === null) return json(res, 400, { error: 'Invalid page' });
      if (!dbPath) return json(res, 200, { source: 'unavailable', works: [] });
      let works;
      try {
        works = readWorks(dbPath, config);
      } catch {
        return json(res, 200, { source: 'unavailable', works: [] });
      }
      const visible = works.slice(offset, offset + page.limit);
      const nextOffset = offset + page.limit;
      return json(res, 200, {
        source: 'available',
        works: visible,
        next: nextOffset < works.length
          ? Buffer.from(JSON.stringify({ offset: nextOffset })).toString('base64url')
          : null,
      });
    }

    if (url.pathname === '/api/queue') {
      if (pageParameter(url.searchParams).error) return json(res, 400, { error: 'Invalid page' });
      const work = readQueueCategory(dbPath, config, Date.now());
      const unavailable = work.status === 'unavailable';
      return json(res, 200, {
        source: unavailable ? 'unavailable' : 'available',
        generated_at: new Date().toISOString(),
        refresh_seconds: config.queueStaleAfterSeconds,
        categories: [work],
        deferred: DEFERRED_CATEGORIES.map((entry) => ({ ...entry, status: 'deferred' })),
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
