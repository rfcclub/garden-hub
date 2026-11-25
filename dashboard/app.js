// Garden Hub dashboard - read-only client.
// It renders only the neutral labels and configured names the server already
// decided are safe to show. No event payload text is fetched or rendered.
'use strict';

(function main() {
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

  clear(eventsBody);
  clear(worksBody);
  loadEvents(null);
  loadWorks(null);
})();
