import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { scanDocsStaleness } from './agent/code-staleness.js';
import log from './agent/logger.js';

const DOCS_DIR = path.join(process.cwd(), 'docs');
const STALE_DAYS = parseInt(process.env.CODE_STALE_DAYS, 10) || 90;
const REPORT_PATH = path.join(process.cwd(), 'code-staleness-report.json');

/**
 * Scans all markdown docs in the docs/ directory for code staleness
 * (files that haven't been updated in the repo within the threshold)
 * and writes a JSON report to code-staleness-report.json.
 */
async function main() {
  log.debug(
    { module: 'code-staleness-detect', docsDir: DOCS_DIR, staleDays: STALE_DAYS },
    'Starting code staleness scan',
  );

  const results = await scanDocsStaleness(DOCS_DIR, { staleDays: STALE_DAYS });

  const staleDocs = results.filter((r) => r.stale);
  const freshDocs = results.filter((r) => !r.stale);

  log.debug(
    { module: 'code-staleness-detect', total: results.length, stale: staleDocs.length, fresh: freshDocs.length },
    'Scan complete',
  );

  for (const doc of staleDocs) {
    log.warn(
      {
        module: 'code-staleness-detect',
        doc: doc.doc,
        lastModified: doc.lastModified,
        daysSinceModified: doc.daysSinceModified,
        author: doc.author,
      },
      'Stale doc detected',
    );
  }

  const report = {
    scannedAt: new Date().toISOString(),
    staleDays: STALE_DAYS,
    total: results.length,
    stale: staleDocs.length,
    docs: results,
  };

  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  log.debug({ module: 'code-staleness-detect', reportPath: REPORT_PATH }, 'Report written');
}

const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith('/code-staleness-detect.js') || process.argv[1].endsWith('\\code-staleness-detect.js'));
if (isMain) main();
