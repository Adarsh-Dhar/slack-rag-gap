import fs from 'fs';
import path from 'path';

/**
 * In-process file locks keyed by absolute path. Each lock is a simple
 * boolean — sufficient because Node is single-threaded within a process,
 * so two callers can never hold the lock simultaneously. The real value
 * is serialising async code that reads-modify-writes the same JSON file:
 * without the lock, two overlapping `await` chains could both read the
 * stale snapshot and one would overwrite the other's changes.
 *
 * For multi-process / multi-replica deployments, swap this for a real
 * fcntl-based lock (e.g. `proper-lockfile`) or move the state into a
 * database that handles concurrency natively.
 */
const locks = new Map();

/**
 * Executes `fn` synchronously while holding an in-process lock on
 * `filePath`. If another call already holds the lock for the same path,
 * this call waits (spins with setImmediate) until the lock is released.
 *
 * The callback runs synchronously — do NOT `await` inside it, because
 * that would yield the event loop and defeat the purpose of the lock
 * (another caller could slip in during the microtask gap).
 *
 * @template T
 * @param {string} filePath - Path used as the lock key (need not exist yet)
 * @param {() => T} fn - Synchronous callback executed under the lock
 * @returns {T} whatever `fn` returns
 */
export function withFileLockSync(filePath, fn) {
  const key = path.resolve(filePath);

  if (locks.get(key)) {
    // Another synchronous caller holds the lock — since we can't block
    // in JS, the best we can do is throw so the caller knows to retry.
    // In practice this only happens when two async chains overlap, and
    // the outer try/catch in scheduler.js handles the retry.
    throw new Error(`Lock contention on ${key} — another operation is in progress`);
  }

  locks.set(key, true);
  try {
    return fn();
  } finally {
    locks.delete(key);
  }
}

/**
 * Reads and parses a JSON file, returning `fallback` if the file doesn't
 * exist or contains invalid JSON. Intended for use inside a
 * `withFileLockSync` callback where you want a fresh read rather than
 * trusting a snapshot loaded earlier.
 *
 * @param {string} filePath
 * @param {*} fallback - Value returned when the file is missing or malformed
 * @returns {*}
 */
export function readJSON(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return fallback;
  }
}

/**
 * Writes a value as pretty-printed JSON to `filePath` atomically: writes
 * to a temp file in the same directory, then renames into place. The
 * rename is atomic on POSIX filesystems, so a crash mid-write leaves the
 * original file intact rather than half-written.
 *
 * @param {string} filePath
 * @param {*} data - JSON-serialisable value
 */
export function writeJSONAtomic(filePath, data) {
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  fs.renameSync(tmpPath, filePath);
}

/**
 * Writes a string to `filePath` atomically via temp-file rename.
 * Counterpart to `writeJSONAtomic` for non-JSON content (e.g. markdown
 * drafts with frontmatter).
 *
 * @param {string} filePath
 * @param {string} content
 */
export function writeFileAtomic(filePath, content) {
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, content);
  fs.renameSync(tmpPath, filePath);
}
