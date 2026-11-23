// ghub-dashboard tests - read-only dashboard, configuration and neutral labels.
// Run: node --test tools/ghub-dashboard.test.mjs
//
// The server binds IPv4 loopback in production. The tests speak HTTP over a
// Unix socket in a temporary directory so they never need a TCP port.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { createDashboardServer, loadConfigFile, normalizeConfig } from './ghub-dashboard.mjs';

const DASHBOARD_DIR = fileURLToPath(new URL('../dashboard/', import.meta.url));

const SECRET_AGENT = 'agent-seven';
const SECRET_PROJECT = 'project-orchid';
const SECRET_REPO = 'example-org/example-repo';
const OTHER_REPO = 'other-org/other-repo';
const SECRET_PAYLOAD = 'payload-text-must-not-cross-the-boundary';
const SECRET_REASON = 'needs-owner: alpha';

function tmpdirFor(name) {
  return mkdtempSync(join(tmpdir(), `ghd-${name}-`));
}

// --- fixtures -------------------------------------------------------------

function eventsDir(events) {
  const dir = tmpdirFor('events');
  const lines = events.map((ev) => JSON.stringify(ev)).join('\n') + '\n';
  writeFileSync(join(dir, 'events-2026-10.jsonl'), lines);
  return dir;
}

function event({ type = 'TASK_CLAIMED', agent = SECRET_AGENT, project = SECRET_PROJECT, payload = { note: SECRET_PAYLOAD } } = {}) {
  return {
    event_id: randomUUID(),
    ts: '2026-10-13T12:00:00.000Z',
    type,
    agent_id: agent,
    payload,
    ...(project ? { project } : {}),
  };
}

function worksDb(rows) {
  const path = join(tmpdirFor('works'), 'works.db');
  const db = new DatabaseSync(path);
  db.exec(
    'CREATE TABLE works (repo TEXT NOT NULL, issue INTEGER NOT NULL, state TEXT NOT NULL,' +
      ' blocked_reason TEXT, pr_url TEXT, updated_at TEXT NOT NULL)',
  );
  const insert = db.prepare(
    'INSERT INTO works (repo, issue, state, blocked_reason, pr_url, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  for (const row of rows) {
    insert.run(row.repo, row.issue, row.state, row.blocked_reason ?? null, row.pr_url ?? null, row.updated_at);
  }
  db.close();
  return path;
}

function workRow({ repo = SECRET_REPO, issue = 8, state = 'blocked', blocked_reason = SECRET_REASON, pr_url = null } = {}) {
  return { repo, issue, state, blocked_reason, pr_url, updated_at: '2026-10-13T12:00:00.000Z' };
}

const CONFIG = {
  agents: [SECRET_AGENT],
  projects: [SECRET_PROJECT],
  repositories: [SECRET_REPO],
  eventTypes: ['TASK_CLAIMED'],
  blockedReasons: [{ pattern: '^needs-owner', label: 'Needs an owner' }],
};

// --- harness --------------------------------------------------------------

async function start(options) {
  const server = createDashboardServer(options);
  const socketPath = join(tmpdirFor('sock'), 's');
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  return {
    socketPath,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function get(socketPath, path, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(
      { socketPath, path, method, headers: { host: '127.0.0.1:7000', ...headers } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function withServer(options, fn) {
  const running = await start(options);
  try {
    return await fn(running);
  } finally {
    await running.close();
  }
}

// --- tests ----------------------------------------------------------------

test('DASH-001: without configuration every event label is neutral', async () => {
  const dir = eventsDir([event()]);
  await withServer({ eventsDir: dir }, async ({ socketPath }) => {
    const res = await get(socketPath, '/api/events');
    assert.equal(res.status, 200);
    for (const secret of [SECRET_AGENT, SECRET_PROJECT, SECRET_PAYLOAD, 'TASK_CLAIMED']) {
      assert.equal(res.body.includes(secret), false, `leaked ${secret}`);
    }
    const page = JSON.parse(res.body);
    assert.equal(page.source, 'available');
    assert.equal(page.events.length, 1);
    assert.equal(page.events[0].agent, 'Other agent');
    assert.equal(page.events[0].project, 'Other project');
    assert.equal(page.events[0].type, 'Other event');
    assert.deepEqual(Object.keys(page.events[0]).sort(), ['agent', 'project', 'ts', 'type']);
  });
});

test('DASH-002: without configuration every works value is neutral', async () => {
  const dbPath = worksDb([workRow({ pr_url: `https://github.com/${SECRET_REPO}/pull/8` })]);
  await withServer({ dbPath }, async ({ socketPath }) => {
    const res = await get(socketPath, '/api/works');
    assert.equal(res.status, 200);
    for (const secret of [SECRET_REPO, SECRET_REASON, 'alpha', 'github.com']) {
      assert.equal(res.body.includes(secret), false, `leaked ${secret}`);
    }
    const page = JSON.parse(res.body);
    assert.equal(page.source, 'available');
    assert.equal(page.works.length, 1);
    assert.equal(page.works[0].repository, 'Other repository');
    assert.equal(page.works[0].reason, 'Other reason');
    assert.equal(page.works[0].pr_url, null);
  });
});

test('DASH-003: without a database path the works endpoint reports unavailable', async () => {
  await withServer({}, async ({ socketPath }) => {
    const res = await get(socketPath, '/api/works');
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { source: 'unavailable', works: [] });
    for (const text of ['error', 'ENOENT', 'sqlite', '.db']) {
      assert.equal(res.body.includes(text), false, `unexpected text ${text}`);
    }
  });
});

test('DASH-003: an unreadable database reports unavailable without error text', async () => {
  const dbPath = join(tmpdirFor('broken'), 'not-a-database.db');
  writeFileSync(dbPath, 'this is not a SQLite file');
  await withServer({ dbPath }, async ({ socketPath }) => {
    const res = await get(socketPath, '/api/works');
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { source: 'unavailable', works: [] });
    assert.equal(res.body.includes(dbPath), false);
  });
});

test('DASH-004: configured names appear and unknown names stay neutral', async () => {
  const dir = eventsDir([
    event(),
    event({ agent: 'agent-unknown', project: 'project-unknown', type: 'BLOCKER_REPORTED' }),
  ]);
  const dbPath = worksDb([workRow(), workRow({ repo: OTHER_REPO, issue: 9 })]);
  await withServer({ config: CONFIG, dbPath, eventsDir: dir }, async ({ socketPath }) => {
    const events = JSON.parse((await get(socketPath, '/api/events')).body);
    const labels = events.events.map((ev) => `${ev.type}|${ev.agent}|${ev.project}`);
    assert.deepEqual(labels.sort(), ['Other event|Other agent|Other project', 'TASK_CLAIMED|agent-seven|project-orchid']);

    const works = JSON.parse((await get(socketPath, '/api/works')).body);
    const repositories = works.works.map((work) => work.repository);
    assert.deepEqual(repositories.sort(), ['Other repository', SECRET_REPO].sort());
    assert.equal((await get(socketPath, '/api/events')).body.includes(SECRET_PAYLOAD), false);
  });
});

test('DASH-005: only a pull-request URL of a configured repository is returned', async () => {
  const dbPath = worksDb([
    workRow({ issue: 8, pr_url: `https://github.com/${SECRET_REPO}/pull/8` }),
    { ...workRow({ issue: 9, repo: OTHER_REPO }), pr_url: `https://github.com/${OTHER_REPO}/pull/9` },
    workRow({ issue: 10, pr_url: `https://github.com/${SECRET_REPO}/issues/10` }),
  ]);
  await withServer({ config: CONFIG, dbPath }, async ({ socketPath }) => {
    const body = (await get(socketPath, '/api/works')).body;
    assert.equal(body.includes(OTHER_REPO), false);
    assert.equal(body.includes('/issues/10'), false);
    const page = JSON.parse(body);
    assert.equal(page.works.length, 3);
    assert.deepEqual(
      page.works.map((work) => work.pr_url).sort(),
      [null, null, `https://github.com/${SECRET_REPO}/pull/8`].sort(),
    );
    const kept = page.works.find((work) => work.pr_url);
    assert.equal(kept.reason, 'Needs an owner');
  });
});

test('DASH-006: the page and its assets are served with a restrictive policy', async () => {
  await withServer({}, async ({ socketPath }) => {
    const page = await get(socketPath, '/');
    assert.equal(page.status, 200);
    assert.match(page.headers['content-type'], /^text\/html/);
    assert.match(page.headers['content-security-policy'], /default-src 'none'/);
    assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.equal(page.headers['x-content-type-options'], 'nosniff');
    assert.equal(page.headers['referrer-policy'], 'no-referrer');
    assert.match(page.body, /<title>/);

    const script = await get(socketPath, '/app.js');
    assert.equal(script.status, 200);
    assert.match(script.headers['content-type'], /^text\/javascript/);
    const style = await get(socketPath, '/styles.css');
    assert.equal(style.status, 200);
    assert.match(style.headers['content-type'], /^text\/css/);

    for (const name of ['index.html', 'app.js', 'styles.css']) {
      const text = readFileSync(join(DASHBOARD_DIR, name), 'utf8');
      for (const secret of [SECRET_AGENT, SECRET_PROJECT, SECRET_REPO, 'github.com', 'sqlite']) {
        assert.equal(text.includes(secret), false, `${name} contains ${secret}`);
      }
    }
    for (const asset of [page.body, script.body, style.body]) {
      for (const secret of [SECRET_AGENT, SECRET_PROJECT, SECRET_REPO]) {
        assert.equal(asset.includes(secret), false, `asset leaked ${secret}`);
      }
    }

    const missing = await get(socketPath, '/../package.json');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.includes('garden-hub'), false);
  });
});

test('DASH-007: only GET from a loopback host and origin is accepted', async () => {
  await withServer({}, async ({ socketPath }) => {
    const post = await get(socketPath, '/api/works', { method: 'POST' });
    assert.equal(post.status, 405);
    assert.equal(post.headers.allow, 'GET');

    const foreignHost = await get(socketPath, '/api/works', { headers: { host: 'example.com' } });
    assert.equal(foreignHost.status, 403);

    const foreignOrigin = await get(socketPath, '/api/works', {
      headers: { origin: 'http://example.com' },
    });
    assert.equal(foreignOrigin.status, 403);

    const localOrigin = await get(socketPath, '/api/works', {
      headers: { origin: 'http://127.0.0.1:7000' },
    });
    assert.equal(localOrigin.status, 200);

    const localhostHost = await get(socketPath, '/api/works', { headers: { host: 'localhost:7000' } });
    assert.equal(localhostHost.status, 200);
  });
});

test('DASH-008: pagination is bounded and a malformed cursor is rejected', async () => {
  const dir = eventsDir([event(), event({ agent: 'agent-unknown' })]);
  await withServer({ eventsDir: dir }, async ({ socketPath }) => {
    assert.equal((await get(socketPath, '/api/events?limit=1')).status, 200);
    assert.equal((await get(socketPath, '/api/events?limit=0')).status, 400);
    assert.equal((await get(socketPath, '/api/events?limit=1000')).status, 400);
    assert.equal((await get(socketPath, '/api/events?limit=abc')).status, 400);
    assert.equal((await get(socketPath, '/api/events?cursor=not-a-cursor')).status, 400);
    assert.equal((await get(socketPath, '/api/works?cursor=not-a-cursor')).status, 400);
    const limited = JSON.parse((await get(socketPath, '/api/events?limit=1')).body);
    assert.equal(limited.events.length, 1);
    assert.equal(typeof limited.next, 'string');
  });
});

test('DASH-009: a configuration file is loaded and validated', () => {
  const dir = tmpdirFor('config');
  const good = join(dir, 'dashboard.json');
  writeFileSync(good, JSON.stringify(CONFIG));
  const config = loadConfigFile(good);
  assert.deepEqual(config.agents, [SECRET_AGENT]);
  assert.deepEqual(config.repositories, [SECRET_REPO]);
  assert.deepEqual(config.eventTypes, ['TASK_CLAIMED']);
  assert.equal(config.blockedReasons.length, 1);

  assert.throws(() => loadConfigFile(join(dir, 'missing.json')), /configuration/i);

  const badType = join(dir, 'bad-type.json');
  writeFileSync(badType, JSON.stringify({ agents: 'agent-seven' }));
  assert.throws(() => loadConfigFile(badType), /agents/);

  const badPattern = join(dir, 'bad-pattern.json');
  writeFileSync(badPattern, JSON.stringify({ blockedReasons: ['[unclosed'] }));
  assert.throws(() => loadConfigFile(badPattern), /blockedReasons/);

  const badRepo = join(dir, 'bad-repo.json');
  writeFileSync(badRepo, JSON.stringify({ repositories: ['not-a-repository'] }));
  assert.throws(() => loadConfigFile(badRepo), /repositories/);
});


// --- needs-the-owner queue ------------------------------------------------
//
// The first source-backed slice is blocked work that an explicit, configured
// rule marks owner-actionable. A row is owner-actionable only when its
// repository is allowlisted, its issue is a positive integer and its
// blocked_reason matches an `ownerActionable` pattern. `state = 'blocked'`
// alone is never enough to promote a row into an owner-action requirement.

const QUEUE_CONFIG = {
  ...CONFIG,
  ownerActionable: ['^needs-owner'],
  queueStaleAfterSeconds: 3600,
};

function isoAgo(seconds) {
  return new Date(Date.now() - seconds * 1000).toISOString();
}

function queueWorkRow({ ageSeconds = 60, ...rest } = {}) {
  return { ...workRow(rest), updated_at: isoAgo(ageSeconds) };
}

function queuePage(socketPath) {
  return get(socketPath, '/api/queue').then((res) => {
    assert.equal(res.status, 200);
    return JSON.parse(res.body);
  });
}

function category(page, id) {
  const found = page.categories.find((entry) => entry.id === id);
  assert.ok(found, `missing category ${id}`);
  return found;
}

test('DASH-010: queue shows owner-actionable blocked work with provenance, age and a safe link', async () => {
  const dbPath = worksDb([
    queueWorkRow({ issue: 8, pr_url: `https://github.com/${SECRET_REPO}/pull/8` }),
    queueWorkRow({ issue: 9, blocked_reason: 'waiting on upstream' }),
    { ...queueWorkRow({ issue: 10 }), repo: OTHER_REPO },
  ]);
  await withServer({ config: QUEUE_CONFIG, dbPath }, async ({ socketPath }) => {
    const page = await queuePage(socketPath);
    assert.equal(page.source, 'available');
    assert.equal(typeof page.generated_at, 'string');
    const work = category(page, 'blocked-work');
    assert.equal(work.status, 'ok');
    assert.equal(work.truncated, false);
    assert.equal(work.items.length, 1);

    const item = work.items[0];
    assert.equal(item.source, 'works');
    assert.equal(item.category, 'blocked-work');
    assert.equal(item.id, `works:${SECRET_REPO}:8`);
    assert.equal(item.repository, SECRET_REPO);
    assert.equal(item.issue, 8);
    assert.equal(typeof item.observed_at, 'string');
    assert.equal(typeof item.age_seconds, 'number');
    assert.ok(item.age_seconds >= 59 && item.age_seconds <= 120, `unexpected age ${item.age_seconds}`);
    assert.equal(item.age_meaning, 'source-updated');
    assert.equal(item.provenance, 'ownerActionable rule on works.blocked_reason');
    assert.deepEqual(item.link, {
      href: `https://github.com/${SECRET_REPO}/pull/8`,
      label: 'Pull request',
      kind: 'pull-request',
    });
    assert.equal(item.first_seen, null);
    assert.equal(item.stale, false);
    for (const excluded of ['waiting on upstream', OTHER_REPO, SECRET_PAYLOAD]) {
      assert.equal(JSON.stringify(page).includes(excluded), false, `leaked ${excluded}`);
    }
  });
});

test('DASH-011: without an owner-actionable rule the queue claims no empty result', async () => {
  const dbPath = worksDb([queueWorkRow()]);
  await withServer({ config: CONFIG, dbPath }, async ({ socketPath }) => {
    const page = await queuePage(socketPath);
    const work = category(page, 'blocked-work');
    assert.equal(work.status, 'rule-missing');
    assert.equal(work.rule_configured, false);
    assert.equal(work.items.length, 0);
    assert.equal(work.complete, false);
  });
});

test('DASH-012: an unavailable source is never an empty complete queue', async () => {
  await withServer({ config: QUEUE_CONFIG }, async ({ socketPath }) => {
    const page = await queuePage(socketPath);
    assert.equal(page.source, 'unavailable');
    const work = category(page, 'blocked-work');
    assert.equal(work.status, 'unavailable');
    assert.equal(work.complete, false);
    assert.deepEqual(work.items, []);
    assert.equal(work.truncated, false);
  });

  const broken = join(tmpdirFor('queue-broken'), 'not-a-database.db');
  writeFileSync(broken, 'not sqlite');
  await withServer({ config: QUEUE_CONFIG, dbPath: broken }, async ({ socketPath }) => {
    const page = await queuePage(socketPath);
    assert.equal(page.source, 'unavailable');
    assert.equal(category(page, 'blocked-work').complete, false);
    assert.equal(JSON.stringify(page).includes(broken), false);
  });
});

test('DASH-013: a truncated source is reported as incomplete, not as the whole queue', async () => {
  const rows = [];
  for (let issue = 1; issue <= 101; issue += 1) rows.push(queueWorkRow({ issue }));
  const dbPath = worksDb(rows);
  await withServer({ config: QUEUE_CONFIG, dbPath }, async ({ socketPath }) => {
    const page = await queuePage(socketPath);
    const work = category(page, 'blocked-work');
    assert.equal(work.status, 'truncated');
    assert.equal(work.truncated, true);
    assert.equal(work.complete, false);
    assert.equal(work.items.length, 100);
    assert.equal(work.limit, 100);
  });
});

test('DASH-014: an observation older than the window is shown as stale', async () => {
  const stalePath = worksDb([queueWorkRow({ issue: 8, ageSeconds: 7200 })]);
  await withServer({ config: QUEUE_CONFIG, dbPath: stalePath }, async ({ socketPath }) => {
    const work = category(await queuePage(socketPath), 'blocked-work');
    assert.equal(work.items[0].stale, true);
    assert.equal(work.stale_items, 1);
    assert.equal(work.status, 'ok');
  });

  const freshPath = worksDb([queueWorkRow({ issue: 8, ageSeconds: 60 })]);
  await withServer({ config: QUEUE_CONFIG, dbPath: freshPath }, async ({ socketPath }) => {
    const work = category(await queuePage(socketPath), 'blocked-work');
    assert.equal(work.items[0].stale, false);
    assert.equal(work.stale_items, 0);
    assert.equal(work.status, 'ok');
  });
});

test('DASH-015: an item leaves the queue only when the source confirms resolution', async () => {
  const dbPath = worksDb([queueWorkRow({ issue: 8 }), queueWorkRow({ issue: 9 })]);
  await withServer({ config: QUEUE_CONFIG, dbPath }, async ({ socketPath }) => {
    const before = category(await queuePage(socketPath), 'blocked-work');
    assert.deepEqual(before.items.map((item) => item.issue), [8, 9]);

    const db = new DatabaseSync(dbPath);
    db.prepare("UPDATE works SET state = 'done' WHERE issue = 8").run();
    db.close();
    const after = category(await queuePage(socketPath), 'blocked-work');
    assert.deepEqual(after.items.map((item) => item.issue), [9]);
    assert.equal(after.complete, true);
  });

  const empty = worksDb([]);
  await withServer({ config: QUEUE_CONFIG, dbPath: empty }, async ({ socketPath }) => {
    const none = category(await queuePage(socketPath), 'blocked-work');
    assert.equal(none.status, 'ok');
    assert.equal(none.items.length, 0);
    assert.equal(none.complete, true);
  });
});

test('DASH-016: queue links stay on allowlisted destinations and unapproved schemes drop out', async () => {
  const dbPath = worksDb([
    { ...queueWorkRow({ issue: 8 }), pr_url: 'javascript:alert(1)' },
    { ...queueWorkRow({ issue: 9 }), pr_url: 'https://example.com/other-org/other-repo/pull/9' },
    queueWorkRow({ issue: 11, pr_url: `https://github.com/${SECRET_REPO}/issues/11` }),
  ]);
  await withServer({ config: QUEUE_CONFIG, dbPath }, async ({ socketPath }) => {
    const page = await queuePage(socketPath);
    const work = category(page, 'blocked-work');
    assert.equal(work.items.length, 3);
    for (const item of work.items) {
      assert.equal(item.link.kind, 'issue');
      assert.equal(item.link.href, `https://github.com/${SECRET_REPO}/issues/${item.issue}`);
      assert.equal(item.link.label, 'Issue');
    }
    const text = JSON.stringify(page);
    for (const unsafe of ['javascript:', 'example.com']) {
      assert.equal(text.includes(unsafe), false, `leaked ${unsafe}`);
    }
  });
});

test('DASH-017: the page names supported and deferred categories and leads with the queue', async () => {
  await withServer({ config: QUEUE_CONFIG }, async ({ socketPath }) => {
    const page = await queuePage(socketPath);
    assert.deepEqual(
      page.categories.map((entry) => entry.id),
      ['blocked-work'],
    );
    assert.equal(category(page, 'blocked-work').label, 'Blocked work');
    assert.deepEqual(
      page.deferred.map((entry) => entry.id).sort(),
      ['pending-approvals', 'pending-confirmations', 'pending-escalations', 'provider-quota', 'unreachable-machines'],
    );
    for (const entry of page.deferred) {
      assert.equal(entry.status, 'deferred');
      assert.equal(typeof entry.label, 'string');
    }

    const html = (await get(socketPath, '/')).body;
    assert.ok(html.includes('id="queue"'), 'queue section is present');
    assert.ok(html.indexOf('id="queue"') < html.indexOf('id="events-heading"'), 'queue comes first');
    assert.ok(html.indexOf('id="queue"') < html.indexOf('id="works-heading"'), 'queue comes first');
    assert.equal(/<form|<button type="submit"/i.test(html), false, 'the queue offers no write action');
  });
});

test('DASH-018: the queue config is validated rather than widened silently', () => {
  assert.throws(() => normalizeConfig({ ownerActionable: 'needs-owner' }), /ownerActionable/);
  assert.throws(() => normalizeConfig({ ownerActionable: ['[unclosed'] }), /ownerActionable/);
  assert.throws(() => normalizeConfig({ queueStaleAfterSeconds: 0 }), /queueStaleAfterSeconds/);
  assert.throws(() => normalizeConfig({ queueStaleAfterSeconds: 'soon' }), /queueStaleAfterSeconds/);
  const normalized = normalizeConfig({ ownerActionable: ['^needs-owner'] });
  assert.deepEqual(normalized.ownerActionable, ['^needs-owner']);
  assert.equal(normalized.queueStaleAfterSeconds, 3600);
});

test('DASH-019: queue items are ordered oldest observation first for triage', async () => {
  const dbPath = worksDb([
    queueWorkRow({ issue: 5, ageSeconds: 600 }),
    queueWorkRow({ issue: 6, ageSeconds: 7200 }),
    queueWorkRow({ issue: 7, ageSeconds: 60 }),
  ]);
  await withServer({ config: QUEUE_CONFIG, dbPath }, async ({ socketPath }) => {
    const work = category(await queuePage(socketPath), 'blocked-work');
    assert.deepEqual(work.items.map((item) => item.issue), [6, 5, 7]);
  });
});

test('DASH-020: an observation with no readable time sorts first and claims no age', async () => {
  const dbPath = worksDb([{ ...queueWorkRow({ issue: 5 }), updated_at: 'not-a-time' }, queueWorkRow({ issue: 6 })]);
  await withServer({ config: QUEUE_CONFIG, dbPath }, async ({ socketPath }) => {
    const work = category(await queuePage(socketPath), 'blocked-work');
    assert.deepEqual(work.items.map((item) => item.issue), [5, 6]);
    assert.equal(work.items[0].age_seconds, null);
    assert.equal(work.items[0].observed_at, null);
    assert.equal(work.items[0].stale, true);
  });
});
