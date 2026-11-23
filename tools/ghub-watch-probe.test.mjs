import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { basename } from 'node:path';

import { HOST_WATCH_BOUNDARY, PROBE_FILE, probeDirectoryWatch } from './ghub-watch-probe.mjs';

// An inert watcher stands in for a host that arms a filesystem watcher but never
// delivers callbacks. This half of the contract must hold on every host.
function inertWatcher() {
  return { on() {}, close() {} };
}

// macOS arm64 (Garden Hub #6) accepts the watcher and emits one arm-time
// `rename` naming the watched directory itself, then stays silent for the
// written probe file. That callback is not a wake capability proof.
function armNoiseOnlyWatcher(path, listener) {
  listener('rename', basename(path));
  return { on() {}, close() {} };
}

test('WATCH-001: a watcher that never fires is reported as unsupported', async () => {
  const result = await probeDirectoryWatch({ watcher: inertWatcher, timeoutMs: 200 });
  assert.equal(result.supported, false);
  assert.deepEqual(result.events, []);
  assert.deepEqual(result.errors, []);
  assert.equal(result.probeFile, PROBE_FILE);
  assert.equal(result.boundary, HOST_WATCH_BOUNDARY);
});

test('WATCH-002: a callback that does not name the probe file is unsupported', async () => {
  const result = await probeDirectoryWatch({
    watcher: armNoiseOnlyWatcher,
    timeoutMs: 200,
  });
  assert.equal(result.supported, false, JSON.stringify(result));
  assert.deepEqual(result.errors, []);
  // Unrelated callbacks must not cut the probe short of its own write.
  assert.equal(result.probeWritten, true);
  assert.ok(result.events.length > 0);
  assert.equal(result.events.some((event) => event.file === PROBE_FILE), false);
});

test('WATCH-003: a callback naming the probe file is supported', async () => {
  let listener;
  const latchWatcher = (path, onEvent) => {
    listener = onEvent;
    return { on() {}, close() {} };
  };
  const result = await probeDirectoryWatch({
    watcher: latchWatcher,
    writeProbe(file) {
      writeFileSync(file, '{}\n');
      listener('rename', basename(file));
    },
    timeoutMs: 200,
  });
  assert.equal(result.supported, true, JSON.stringify(result));
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.events, [{ event: 'rename', file: PROBE_FILE }]);
});

test('WATCH-004: host capability stays out of the default test suite', async () => {
  const { readFile } = await import('node:fs/promises');
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  // The CLI verdict depends on the host; default `npm test` must not gate on it
  // and stays green at the reported boundary (see docs/channel-wake.md).
  assert.match(manifest.scripts['test:watch-probe'], /ghub-watch-probe\.mjs/);
  assert.equal(manifest.scripts.test.includes('ghub-watch-probe.mjs'), false);
  assert.match(manifest.scripts.test, /ghub-watch-probe\.test\.mjs/);
});
