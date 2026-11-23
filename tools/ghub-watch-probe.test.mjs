import test from 'node:test';
import assert from 'node:assert/strict';

import { HOST_WATCH_BOUNDARY, probeDirectoryWatch } from './ghub-watch-probe.mjs';

// An inert watcher stands in for a host that arms a filesystem watcher but never
// delivers callbacks. This half of the contract must hold on every host.
function inertWatcher() {
  return { on() {}, close() {} };
}

test('WATCH-001: a watcher that never fires is reported as unsupported', async () => {
  const result = await probeDirectoryWatch({ watcher: inertWatcher, timeoutMs: 200 });
  assert.equal(result.supported, false);
  assert.deepEqual(result.events, []);
  assert.deepEqual(result.errors, []);
  assert.equal(result.boundary, HOST_WATCH_BOUNDARY);
});

test('WATCH-002: this host delivers a filesystem callback for a written file', async () => {
  const result = await probeDirectoryWatch({ timeoutMs: 5000 });
  assert.equal(
    result.supported,
    true,
    `${HOST_WATCH_BOUNDARY}; observed ${JSON.stringify(result)}`,
  );
});
