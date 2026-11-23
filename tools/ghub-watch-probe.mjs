import { mkdtempSync, realpathSync, rmSync, watch as fsWatch, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Channel wake is bounded by the host's filesystem watcher. Arming a watcher
// proves nothing: some hosts accept the watcher and never deliver a callback.
export const HOST_WATCH_BOUNDARY =
  'channel wake requires a host whose fs.watch delivers callbacks; ' +
  'where callbacks never arrive a live connection stays silent, ' +
  'so mail must be read with message_inbox';

export const PROBE_FILE = 'probe.json';

function namesProbe(record) {
  return record.file !== null && basename(record.file) === PROBE_FILE;
}

// Writes one probe file into a private temporary directory and reports whether
// the host delivered a callback naming that file. Unrelated callbacks do not
// count: macOS arm64 (Garden Hub #6) emits a single arm-time `rename` for the
// watched directory itself and then nothing for later writes, which would
// otherwise read as a capability proof. The watcher and the write are
// injectable so both halves are testable everywhere.
export async function probeDirectoryWatch({
  watcher = (path, listener) => fsWatch(path, listener),
  writeProbe = (file) => writeFileSync(file, '{}\n'),
  timeoutMs = 2000,
  settleMs = 25,
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ghub-watch-probe-'));
  const events = [];
  const errors = [];
  let probeWritten = false;
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
          writeProbe(join(dir, PROBE_FILE));
          probeWritten = true;
        } catch (error) {
          errors.push(error.message);
          finish();
        }
      }, settleMs));
      timers.push(setTimeout(finish, timeoutMs));
    });
    handle = watcher(dir, (event, file) => {
      const record = { event, file: typeof file === 'string' ? file : null };
      events.push(record);
      if (namesProbe(record)) finish();
    });
    handle.on?.('error', (error) => {
      errors.push(error.message);
      finish();
    });
    await observed;
  } catch (error) {
    errors.push(error.message);
    // The watcher never armed, so the settle and timeout timers must be
    // disarmed here: left running they would write into the temporary
    // directory after it is removed and append a late ENOENT to the errors.
    for (const timer of timers) clearTimeout(timer);
    settled?.();
  } finally {
    handle?.close?.();
    rmSync(dir, { recursive: true, force: true });
  }
  const supported = probeWritten && events.some(namesProbe);
  return { supported, probeFile: PROBE_FILE, probeWritten, events, errors, boundary: HOST_WATCH_BOUNDARY };
}

async function main() {
  const result = await probeDirectoryWatch({ timeoutMs: 3000 });
  process.stdout.write(`${JSON.stringify({ node: process.version, ...result })}\n`);
  if (!result.supported) {
    process.stderr.write(`garden-hub: ${HOST_WATCH_BOUNDARY}\n`);
    process.exitCode = 1;
  }
}

// Run the CLI only when invoked directly (not when imported by a test).
// Compare realpaths so a symlinked invocation also works: argv[1] is a path
// while import.meta.url is a file URL, and neither spelling is symlink-free.
export function isMainInvocation(argv = process.argv, self = import.meta.url) {
  if (!argv[1]) return false;
  try {
    const selfPath = self instanceof URL || String(self).startsWith('file:')
      ? fileURLToPath(self)
      : String(self);
    return realpathSync(argv[1]) === realpathSync(selfPath);
  } catch {
    return false;
  }
}

if (isMainInvocation()) {
  await main();
}
