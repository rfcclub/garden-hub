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

import { createDashboardServer, loadConfigFile } from './ghub-dashboard.mjs';

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

function workRow({
  repo = SECRET_REPO,
  issue = 8,
  state = 'blocked',
  blocked_reason = SECRET_REASON,
  pr_url = null,
  updated_at = '2026-10-13T12:00:00.000Z',
} = {}) {
  return { repo, issue, state, blocked_reason, pr_url, updated_at };
}

function changeWorksDb(path, statement, ...params) {
  const db = new DatabaseSync(path);
  try {
    db.prepare(statement).run(...params);
  } finally {
    db.close();
  }
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
    workRow({ issue: 11, pr_url: `https://gitlab.example/${SECRET_REPO}/pull/11` }),
  ]);
  await withServer({ config: CONFIG, dbPath }, async ({ socketPath }) => {
    const body = (await get(socketPath, '/api/works')).body;
    assert.equal(body.includes(OTHER_REPO), false);
    assert.equal(body.includes('/issues/10'), false);
    assert.equal(body.includes('gitlab.example'), false);
    const page = JSON.parse(body);
    assert.equal(page.works.length, 4);
    assert.deepEqual(
      page.works.map((work) => work.pr_url).sort(),
      [null, null, null, `https://github.com/${SECRET_REPO}/pull/8`].sort(),
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

test('DASH-010: the works cursor survives rows leaving the blocked queue', async () => {
  const dbPath = worksDb([
    workRow({ issue: 1, updated_at: '2026-10-13T10:00:00.000Z' }),
    workRow({ issue: 2, updated_at: '2026-10-13T11:00:00.000Z' }),
    workRow({ issue: 3, updated_at: '2026-10-13T12:00:00.000Z' }),
  ]);
  await withServer({ dbPath }, async ({ socketPath }) => {
    const first = JSON.parse((await get(socketPath, '/api/works?limit=2')).body);
    assert.deepEqual(first.works.map((work) => work.issue), [3, 2]);
    assert.equal(typeof first.next, 'string');

    // The newest blocked row stops being blocked between the two pages.
    changeWorksDb(dbPath, "UPDATE works SET state = 'done' WHERE issue = 3");

    const second = JSON.parse(
      (await get(socketPath, `/api/works?limit=2&cursor=${first.next}`)).body,
    );
    assert.equal(second.source, 'available');
    assert.deepEqual(second.works.map((work) => work.issue), [1]);
    assert.equal(second.next, null);
  });
});

test('DASH-011: the works cursor never duplicates a row that arrives at the top', async () => {
  const dbPath = worksDb([
    workRow({ issue: 1, updated_at: '2026-10-13T10:00:00.000Z' }),
    workRow({ issue: 2, updated_at: '2026-10-13T11:00:00.000Z' }),
    workRow({ issue: 3, updated_at: '2026-10-13T12:00:00.000Z' }),
  ]);
  await withServer({ dbPath }, async ({ socketPath }) => {
    const first = JSON.parse((await get(socketPath, '/api/works?limit=2')).body);
    assert.deepEqual(first.works.map((work) => work.issue), [3, 2]);

    changeWorksDb(
      dbPath,
      "INSERT INTO works (repo, issue, state, blocked_reason, pr_url, updated_at) VALUES (?, 4, 'blocked', ?, NULL, '2026-10-13T13:00:00.000Z')",
      SECRET_REPO,
      SECRET_REASON,
    );

    const second = JSON.parse(
      (await get(socketPath, `/api/works?limit=2&cursor=${first.next}`)).body,
    );
    assert.deepEqual(second.works.map((work) => work.issue), [1]);
    assert.equal(second.next, null);
  });
});
