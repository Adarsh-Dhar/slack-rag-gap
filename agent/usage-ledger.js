import path from 'node:path';
import { readJSON, withFileLockSync, writeJSONAtomic } from './store.js';

const DEFAULT_LEDGER_PATH = path.resolve(process.cwd(), 'doc-usage.json');

/**
 * Reads doc-usage.json, increments the specified counter(s) for each source,
 * and writes atomically via a temp-file rename — all under a lock, so two
 * concurrent calls (e.g. two questions answered from the same doc at
 * nearly the same moment, or two worker replicas) both land instead of one
 * overwriting the other's increment.
 *
 * @param {string[]} sources - Array of document filenames (e.g. ["handbook.md"])
 * @param {'citedCount' | 'followUpCount' | 'correctionCount'} field
 * @param {string} [ledgerPath] - Override for testing; defaults to ./doc-usage.json
 */
export function updateUsageLedger(sources, field, ledgerPath) {
  // No-op for empty sources
  if (!sources || sources.length === 0) {
    return;
  }

  const resolvedPath = ledgerPath ?? DEFAULT_LEDGER_PATH;

  withFileLockSync(resolvedPath, () => {
    const ledger = readJSON(resolvedPath, {});
    const now = new Date().toISOString();

    for (const source of sources) {
      // Initialize missing entries with default shape
      if (!ledger[source]) {
        ledger[source] = {
          citedCount: 0,
          followUpCount: 0,
          correctionCount: 0,
          lastCited: '',
        };
      }

      if (field === 'citedCount') {
        ledger[source].citedCount += 1;
        ledger[source].lastCited = now;
      } else if (field === 'followUpCount') {
        ledger[source].followUpCount += 1;
      } else if (field === 'correctionCount') {
        // correctionCount also increments followUpCount per spec (Req 2.6)
        ledger[source].correctionCount += 1;
        ledger[source].followUpCount += 1;
      }
    }

    writeJSONAtomic(resolvedPath, ledger);
  });
}
