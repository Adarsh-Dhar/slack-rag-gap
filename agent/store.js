import fs from 'node:fs';

// If a lock directory is older than this, assume its holder crashed while
// holding it (process killed, etc.) and steal the lock rather than wait
// forever for a release that will never come.
const STALE_LOCK_MS = 10_000;
const RETRY_DELAY_MS = 25;
const MAX_WAIT_MS = 5_000;

/**
 * Blocks the current thread for `ms` milliseconds, synchronously.
 * Used to poll for a lock without an async/await refactor across every
 * caller — acceptable here because lock hold times in this codebase are
 * always a single fast JSON read+write (sub-millisecond), never a network
 * call, so worst-case contention is a few retries at 25ms each.
 */
function sleepSync(ms) {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

function acquireLockSync(lockPath) {
  const deadline = Date.now() + MAX_WAIT_MS;
  for (;;) {
    try {
      // mkdir is atomic on POSIX filesystems: exactly one caller (in this
      // process or any other process on the same machine/disk) can create
      // it. Everyone else gets EEXIST and knows to wait. This is what
      // makes the lock work *across processes*, unlike an in-memory Map.
      fs.mkdirSync(lockPath);
      return;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;

      try {
        const age = Date.now() - fs.statSync(lockPath).mtimeMs;
        if (age > STALE_LOCK_MS) {
          fs.rmdirSync(lockPath);
          continue; // retry the mkdir immediately
        }
      } catch {
        // Lock was removed between our EEXIST and this statSync (the
        // holder just finished) — just retry the mkdir on the next loop.
      }

      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for lock: ${lockPath}`);
      }
      sleepSync(RETRY_DELAY_MS);
    }
  }
}

function releaseLockSync(lockPath) {
  try {
    fs.rmdirSync(lockPath);
  } catch {
    // Already gone (e.g. stolen as stale by someone else) — fine to ignore.
  }
}

/**
 * Runs `fn` while holding an exclusive lock on `${filePath}.lock`.
 *
 * This makes a read-modify-write sequence (read JSON, change it, write it
 * back) atomic with respect to every other caller using the same
 * filePath — whether that's another async handler in this same process
 * (two Slack events arriving close together) or a completely separate
 * process (e.g. a second worker replica, or the scheduler and a live
 * Slack event firing at the same moment). The lock lives on disk
 * (a directory), not in process memory, so it's visible to every process.
 *
 * `fn` must be synchronous — do not perform network calls (e.g. Slack API
 * requests) inside it, since the lock is held via a blocking sync wait.
 * Keep locked sections to "read this JSON file, compute, write it back."
 *
 * @template T
 * @param {string} filePath
 * @param {() => T} fn
 * @returns {T}
 */
export function withFileLockSync(filePath, fn) {
  const lockPath = `${filePath}.lock`;
  acquireLockSync(lockPath);
  try {
    return fn();
  } finally {
    releaseLockSync(lockPath);
  }
}

/**
 * Reads and parses a JSON file, returning `fallback` if it doesn't exist
 * or contains invalid JSON.
 */
export function readJSON(filePath, fallback = {}) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return fallback;
  }
}

/**
 * Writes JSON to disk atomically: write to a uniquely-named temp file,
 * then rename it into place. rename() is atomic on POSIX filesystems, so
 * readers never observe a partially-written file. The temp name includes
 * the PID and a timestamp so two concurrent writers never collide on the
 * same temp path even before either has taken the lock.
 */
export function writeJSONAtomic(filePath, data) {
  writeFileAtomic(filePath, JSON.stringify(data, null, 2));
}

/**
 * Writes raw text to disk atomically (temp file + rename), for files that
 * aren't JSON — e.g. draft markdown files. Same guarantee as
 * writeJSONAtomic: readers never observe a partially-written file, and
 * two concurrent writers never collide on the same temp path.
 */
export function writeFileAtomic(filePath, content) {
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, content);
  fs.renameSync(tmpPath, filePath);
}
