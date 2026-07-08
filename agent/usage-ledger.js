import fs from 'fs';
import path from 'path';

const DEFAULT_LEDGER_PATH = path.resolve(process.cwd(), 'doc-usage.json');

/**
 * Reads doc-usage.json, increments the specified counter(s) for each source,
 * and writes atomically via a temp-file rename.
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
  const tmpPath = resolvedPath + '.tmp';

  // Read existing ledger or start fresh
  let ledger = {};
  if (fs.existsSync(resolvedPath)) {
    try {
      const raw = fs.readFileSync(resolvedPath, 'utf-8');
      ledger = JSON.parse(raw);
    } catch (err) {
      console.warn('doc-usage.json contains malformed JSON; resetting ledger.', err.message);
      ledger = {};
    }
  }

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

  // Atomic write: write to temp file, then rename into place
  fs.writeFileSync(tmpPath, JSON.stringify(ledger, null, 2));
  fs.renameSync(tmpPath, resolvedPath);
}
