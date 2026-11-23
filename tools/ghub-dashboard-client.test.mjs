// ghub-dashboard client tests - the read-only page renders only what the
// server decided is safe, and still refuses an unsafe link on its own.
// Run: node --test tools/ghub-dashboard-client.test.mjs
//
// jsdom is a devDependency and is installed by `npm ci`. When it is not
// resolvable the tests skip instead of failing the rest of the suite.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DASHBOARD_DIR = fileURLToPath(new URL('../dashboard/', import.meta.url));
const HTML = readFileSync(new URL('../dashboard/index.html', import.meta.url), 'utf8');
const APP = readFileSync(new URL('../dashboard/app.js', import.meta.url), 'utf8');

let JSDOM = null;
try {
  ({ JSDOM } = await import('jsdom'));
} catch {
  /* jsdom is not installed in this environment */
}
const skip = JSDOM === null ? 'jsdom is not installed' : false;

const ITEM = {
  id: 'works:example-org/example-repo:8',
  source: 'works',
  category: 'blocked-work',
  repository: 'example-org/example-repo',
  issue: 8,
  description: 'Needs an owner',
  observed_at: null,
  age_seconds: 7200,
  age_meaning: 'source-updated',
  first_seen: null,
  provenance: 'ownerActionable rule on works.blocked_reason',
  link: null,
  stale: true,
};

function page(overrides = {}) {
  return {
    source: 'available',
    generated_at: '2026-10-13T12:00:00.000Z',
    refresh_seconds: 3600,
    categories: [
      {
        id: 'blocked-work',
        label: 'Blocked work',
        source: 'works',
        status: 'ok',
        complete: true,
        truncated: false,
        stale_items: 2,
        limit: 100,
        items: [ITEM, { ...ITEM, issue: 9, link: { href: 'javascript:alert(1)', label: 'Pull request' } }],
      },
    ],
    deferred: [{ id: 'pending-approvals', label: 'Pending intent approvals', status: 'deferred' }],
    ...overrides,
  };
}

// Renders index.html plus app.js against one canned /api/queue response.
async function render(payload) {
  const dom = new JSDOM(HTML, { url: 'http://127.0.0.1:47820/', runScripts: 'outside-only' });
  dom.window.fetch = async () => ({ ok: true, json: async () => payload });
  dom.window.eval(APP);
  await new Promise((resolve) => setTimeout(resolve, 50));
  return dom.window.document;
}

test('DASH-020: the queue renders provenance, age, staleness and only https links', { skip }, async () => {
  const document = await render(page());
  const items = [...document.querySelectorAll('#queue-list .queue-item')];
  assert.equal(items.length, 2);
  assert.match(items[0].textContent, /Needs an owner/);
  assert.match(items[0].textContent, /example-org\/example-repo/);
  assert.match(items[0].textContent, /observed 2 hours ago/);
  assert.match(items[0].textContent, /Provenance: ownerActionable rule on works\.blocked_reason/);
  assert.match(items[0].textContent, /older than the refresh window/);
  assert.deepEqual([...document.querySelectorAll('#queue-list a')], [], 'no unsafe link is rendered');
  assert.equal(document.body.innerHTML.includes('javascript:'), false);
});

test('DASH-021: the queue names supported and deferred categories and offers no write action', { skip }, async () => {
  const document = await render(page());
  assert.match(document.getElementById('queue-status').textContent, /read-only/);
  const categories = document.getElementById('queue-categories').textContent;
  assert.match(categories, /Blocked work: 2 active items\./);
  assert.match(categories, /Pending intent approvals: not yet supported \(deferred\)/);
  assert.equal(document.querySelectorAll('form').length, 0);
});

test('DASH-022: an unavailable source is shown as uncertain, never as an empty queue', { skip }, async () => {
  const document = await render(
    page({
      source: 'unavailable',
      categories: [
        { id: 'blocked-work', label: 'Blocked work', source: 'works', status: 'unavailable', complete: false, truncated: false, stale_items: 0, items: [] },
      ],
      deferred: [],
    }),
  );
  assert.match(document.getElementById('queue-status').textContent, /not an empty queue/);
  assert.match(document.getElementById('queue-categories').textContent, /Source unavailable/);
  assert.equal(document.querySelectorAll('#queue-list .queue-item').length, 0);
});

test('DASH-023: a truncated or rule-missing source is never reported as complete', { skip }, async () => {
  for (const [status, pattern] of [
    ['truncated', /incomplete/],
    ['rule-missing', /No owner-actionable rule/],
  ]) {
    const document = await render(
      page({
        categories: [
          { id: 'blocked-work', label: 'Blocked work', source: 'works', status, complete: false, truncated: status === 'truncated', stale_items: 0, items: [] },
        ],
        deferred: [],
      }),
    );
    assert.match(document.getElementById('queue-categories').textContent, pattern);
  }
});
