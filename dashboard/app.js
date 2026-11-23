// Garden Hub dashboard - read-only client.
// It renders only the neutral labels and configured names the server already
// decided are safe to show. No event payload text is fetched or rendered.
'use strict';

(function main() {
  const queueList = document.getElementById('queue-list');
  const queueStatus = document.getElementById('queue-status');
  const queueCategories = document.getElementById('queue-categories');
  const eventsBody = document.getElementById('events-body');
  const eventsStatus = document.getElementById('events-status');
  const eventsMore = document.getElementById('events-more');
  const worksBody = document.getElementById('works-body');
  const worksStatus = document.getElementById('works-status');
  const worksMore = document.getElementById('works-more');

  function cell(text) {
    const td = document.createElement('td');
    td.textContent = text === null || text === undefined ? '' : String(text);
    return td;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function safeHref(value) {
    // The server only builds links from allowlisted destinations. The client
    // still refuses anything that is not a plain https URL, so a future source
    // cannot smuggle in another scheme.
    if (typeof value !== 'string') return null;
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      return null;
    }
    return parsed.protocol === 'https:' ? parsed.href : null;
  }

  function formatAge(seconds) {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return 'observed at an unknown time';
    if (seconds < 90) return 'observed less than two minutes ago';
    const minutes = Math.round(seconds / 60);
    if (minutes < 90) return `observed ${minutes} minutes ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `observed ${hours} hours ago`;
    return `observed ${Math.round(hours / 24)} days ago`;
  }

  const CATEGORY_STATE = {
    ok: (category) =>
      category.items.length === 0
        ? `No active items. Source checked and current.`
        : `${category.items.length} active ${category.items.length === 1 ? 'item' : 'items'}.`,
    truncated: () => 'Source returned more rows than the queue reads; this list is incomplete.',
    unavailable: () => 'Source unavailable. This is not an empty queue.',
    'rule-missing': () => 'No owner-actionable rule is configured, so nothing is shown or claimed.',
  };

  function queueItem(item) {
    const li = document.createElement('li');
    li.className = 'queue-item';

    const heading = document.createElement('p');
    heading.className = 'queue-item-heading';
    heading.textContent = item.description === undefined || item.description === null ? 'Unknown reason' : String(item.description);
    li.append(heading);

    const meta = document.createElement('p');
    meta.className = 'status';
    const parts = [String(item.category || 'unknown category'), String(item.source || 'unknown source')];
    if (item.repository) parts.push(String(item.repository));
    if (item.issue) parts.push(`#${item.issue}`);
    meta.textContent = `${parts.join(' - ')} - ${formatAge(item.age_seconds)} (${String(item.age_meaning || 'unknown')})`;
    li.append(meta);

    if (typeof item.provenance === 'string') {
      const provenance = document.createElement('p');
      provenance.className = 'status';
      provenance.textContent = `Provenance: ${item.provenance}`;
      li.append(provenance);
    }

    if (item.stale === true) {
      const stale = document.createElement('p');
      stale.className = 'status stale';
      stale.textContent = 'This observation is older than the refresh window.';
      li.append(stale);
    }

    const href = item.link ? safeHref(item.link.href) : null;
    if (href) {
      const resolve = document.createElement('p');
      const a = document.createElement('a');
      a.href = href;
      a.rel = 'noopener noreferrer';
      a.textContent = typeof item.link.label === 'string' ? item.link.label : 'Open source';
      resolve.append(a);
      li.append(resolve);
    }

    return li;
  }

  function loadQueue() {
    fetchPage('/api/queue', null)
      .then((page) => {
        clear(queueList);
        const lines = [];
        for (const category of Array.isArray(page.categories) ? page.categories : []) {
          const describe = CATEGORY_STATE[category.status] || (() => 'Source state unknown.');
          const header = document.createElement('li');
          header.className = 'queue-category';
          const title = document.createElement('p');
          title.className = 'queue-item-heading';
          title.textContent = typeof category.label === 'string' ? category.label : 'Unnamed category';
          const state = document.createElement('p');
          state.className = 'status';
          state.textContent = describe(category);
          header.append(title, state);
          queueList.append(header);
          for (const item of Array.isArray(category.items) ? category.items : []) {
            queueList.append(queueItem(item));
          }
          lines.push(`${title.textContent}: ${state.textContent}`);
        }
        for (const deferred of Array.isArray(page.deferred) ? page.deferred : []) {
          lines.push(`${typeof deferred.label === 'string' ? deferred.label : 'Unnamed category'}: not yet supported (${String(deferred.status || 'deferred')})`);
        }
        queueStatus.textContent =
          page.source === 'available'
            ? 'Ordered for the owner to triage. Resolve items at their source; this page is read-only.'
            : 'The queue source is unavailable. This is not an empty queue.';
        queueCategories.textContent = lines.join(' ');
      })
      .catch(() => {
        clear(queueList);
        queueCategories.textContent = '';
        queueStatus.textContent = 'The queue source is unavailable. This is not an empty queue.';
      });
  }

  function formatTime(value) {
    if (typeof value !== 'string') return '';
    const ms = Date.parse(value);
    if (!Number.isFinite(ms)) return '';
    return new Date(ms).toISOString().replace('T', ' ').replace('.000Z', ' UTC');
  }

  async function fetchPage(path, cursor) {
    const url = new URL(path, window.location.origin);
    if (cursor) url.searchParams.set('cursor', cursor);
    const response = await fetch(url, { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error('request failed');
    return response.json();
  }

  async function loadEvents(cursor) {
    try {
      const page = await fetchPage('/api/events', cursor);
      if (page.source !== 'available') {
        eventsStatus.textContent = 'Events are unavailable.';
        eventsMore.hidden = true;
        return;
      }
      for (const event of page.events) {
        const row = document.createElement('tr');
        row.append(cell(formatTime(event.ts)), cell(event.type), cell(event.agent), cell(event.project));
        eventsBody.append(row);
      }
      eventsStatus.textContent = 'Events shown newest first.';
      eventsMore.hidden = !page.next;
      eventsMore.dataset.cursor = page.next || '';
    } catch {
      eventsStatus.textContent = 'Events are unavailable.';
      eventsMore.hidden = true;
    }
  }

  async function loadWorks(cursor) {
    try {
      const page = await fetchPage('/api/works', cursor);
      if (page.source !== 'available') {
        worksStatus.textContent = 'Blocked work is unavailable.';
        worksMore.hidden = true;
        return;
      }
      for (const work of page.works) {
        const row = document.createElement('tr');
        const link = document.createElement('td');
        if (typeof work.pr_url === 'string') {
          const a = document.createElement('a');
          a.href = work.pr_url;
          a.rel = 'noopener noreferrer';
          a.textContent = 'Pull request';
          link.append(a);
        }
        row.append(
          cell(work.repository),
          cell(work.issue),
          cell(work.reason),
          link,
          cell(formatTime(work.updated_at)),
        );
        worksBody.append(row);
      }
      worksStatus.textContent = 'Blocked work shown newest first.';
      worksMore.hidden = !page.next;
      worksMore.dataset.cursor = page.next || '';
    } catch {
      worksStatus.textContent = 'Blocked work is unavailable.';
      worksMore.hidden = true;
    }
  }

  eventsMore.addEventListener('click', () => {
    const cursor = eventsMore.dataset.cursor;
    if (cursor) loadEvents(cursor);
  });

  worksMore.addEventListener('click', () => {
    const cursor = worksMore.dataset.cursor;
    if (cursor) loadWorks(cursor);
  });

  clear(queueList);
  clear(eventsBody);
  clear(worksBody);
  loadQueue();
  loadEvents(null);
  loadWorks(null);
})();
