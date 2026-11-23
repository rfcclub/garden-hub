import { mkdtempSync, rmSync, watch as fsWatch, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Channel wake is bounded by the host's filesystem watcher. Arming a watcher
// proves nothing: some hosts accept the watcher and never deliver a callback.
export const HOST_WATCH_BOUNDARY =
  'channel wake requires a host whose fs.watch delivers callbacks; ' +
  'where callbacks never arrive a live connection stays silent, ' +
  'so mail must be read with message_inbox';

// Writes one probe file into a private temporary directory and reports whether
// the host delivered any callback for it. The watcher implementation is
// injectable so the "armed but never fires" half is testable everywhere.
export async function probeDirectoryWatch({
  watcher = (path, listener) => fsWatch(path, listener),
  timeoutMs = 2000,
  settleMs = 25,
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ghub-watch-probe-'));
  const events = [];
  const errors = [];
  let handle;
  let settled;
  const timers = [];
  function finish() {
    for (const timer of timers) clearTimeout(timer);
    settled();
  }
  try {
    const observed = new Promise((resolve) => {
      settled = resolve;
      timers.push(setTimeout(() => {
        try {
          writeFileSync(join(dir, 'probe.json'), '{}\n');
        } catch (error) {
          errors.push(error.message);
          finish();
        }
      }, settleMs));
      timers.push(setTimeout(finish, timeoutMs));
    });
    handle = watcher(dir, (event, file) => {
      events.push({ event, file: typeof file === 'string' ? file : null });
      finish();
    });
    handle.on?.('error', (error) => {
      errors.push(error.message);
      finish();
    });
    await observed;
  } catch (error) {
    errors.push(error.message);
  } finally {
    handle?.close?.();
    rmSync(dir, { recursive: true, force: true });
  }
  return { supported: events.length > 0, events, errors, boundary: HOST_WATCH_BOUNDARY };
}

async function main() {
  const result = await probeDirectoryWatch({ timeoutMs: 3000 });
  process.stdout.write(`${JSON.stringify({ node: process.version, ...result })}\n`);
  if (!result.supported) {
    process.stderr.write(`garden-hub: ${HOST_WATCH_BOUNDARY}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
