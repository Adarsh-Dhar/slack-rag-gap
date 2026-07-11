import log from './logger.js';
import { readJSON, withFileLockSync, writeJSONAtomic } from './store.js';

// ---------------------------------------------------------------------------
// In-memory run summary — reset each scheduler tick, read by the scheduler
// to log a single structured "run complete" line with totals.
// ---------------------------------------------------------------------------

let runTotals = { attempted: 0, succeeded: 0, failed: 0 };

/**
 * Resets the in-memory run totals. Call once at the top of each job run
 * (scheduler.js does this before awaiting the job function).
 */
export function resetRunSummary() {
  runTotals = { attempted: 0, succeeded: 0, failed: 0 };
}

/**
 * Returns a snapshot of the current run totals for structured logging.
 * The scheduler calls this after a job finishes and spreads the result
 * into the completion log line.
 *
 * @returns {{ attempted: number, succeeded: number, failed: number }}
 */
export function runSummary() {
  return { ...runTotals };
}

/**
 * Records one successful cluster/draft processing. Bumps the in-memory
 * success counter. No disk write needed — success is the absence of a
 * dead-letter entry.
 */
export function recordSuccess() {
  runTotals.attempted++;
  runTotals.succeeded++;
}

/**
 * Records a draft-processing failure. Appends (or increments) an entry
 * in the dead-letter JSON file AND bumps the in-memory failure counter.
 *
 * Uses the same atomic-write + file-lock pattern as the rest of the
 * codebase so concurrent scheduler runs can't corrupt the file.
 *
 * @param {string} filePath - Absolute path to failed-drafts.json
 * @param {{ cluster: string, error: string, channel?: string, thread_ts?: string, missingScope?: boolean, lastAttemptAt: string }} entry
 */
export function recordFailure(filePath, entry) {
  runTotals.attempted++;
  runTotals.failed++;

  try {
    withFileLockSync(filePath, () => {
      const deadLetters = readJSON(filePath, {});
      const key = entry.cluster;
      const existing = deadLetters[key];

      deadLetters[key] = {
        ...entry,
        consecutiveFailures: (existing?.consecutiveFailures ?? 0) + 1,
        firstSeenAt: existing?.firstSeenAt ?? entry.lastAttemptAt,
      };

      writeJSONAtomic(filePath, deadLetters);
    });
  } catch (err) {
    // If we can't even write the dead-letter file (disk full, perms, etc.),
    // at least log the failure so it's not completely invisible.
    log.error({ module: 'failure-counter', err: err.message, entry }, 'Could not persist dead-letter entry');
  }
}

/**
 * Removes a cluster from the dead-letter file (called when a draft for
 * that cluster succeeds — the gap resolved on a later attempt).
 *
 * @param {string} filePath - Absolute path to failed-drafts.json
 * @param {string} clusterKey - The representative question text
 */
export function pruneSuccess(filePath, clusterKey) {
  recordSuccess();
  try {
    withFileLockSync(filePath, () => {
      const deadLetters = readJSON(filePath, {});
      if (deadLetters[clusterKey]) {
        delete deadLetters[clusterKey];
        writeJSONAtomic(filePath, deadLetters);
      }
    });
  } catch (err) {
    log.error({ module: 'failure-counter', err: err.message, clusterKey }, 'Could not prune dead-letter entry');
  }
}

/**
 * Reads the current dead-letter file and returns clusters that have
 * failed at least `minConsecutive` times in a row. Useful for alerting
 * or for a Slack command that surfaces persistent failures.
 *
 * @param {string} filePath - Absolute path to failed-drafts.json
 * @param {number} [minConsecutive=3] - Minimum consecutive failures to surface
 * @returns {Array<{ cluster: string, error: string, consecutiveFailures: number, firstSeenAt: string, lastAttemptAt: string }>}
 */
export function getPersistentFailures(filePath, minConsecutive = 3) {
  const deadLetters = readJSON(filePath, {});
  return Object.values(deadLetters).filter((entry) => entry.consecutiveFailures >= minConsecutive);
}
