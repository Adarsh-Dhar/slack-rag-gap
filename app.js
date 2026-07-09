import 'dotenv/config';
import { App, LogLevel } from '@slack/bolt';
import { registerListeners } from './listeners/index.js';
import { ingestFile } from './ingest.js';
import { startScheduler } from './scheduler.js';
import fs from 'fs';
import path from 'path';

const DOCS_DIR = path.join(process.cwd(), 'docs');

/**
 * Verifies ChromaDB is reachable before starting the app.
 * Retries a few times to handle startup-order races (e.g. when slack run
 * restarts the app before ChromaDB is fully ready).
 * ChromaDB must be running separately — start it with: npm run chroma
 */
async function checkChroma() {
  const chromaUrl = (process.env.CHROMA_URL ?? 'http://localhost:8000').replace('localhost', '127.0.0.1');
  const url = `${chromaUrl}/api/v2/heartbeat`;
  const MAX_RETRIES = 5;
  const RETRY_DELAY_MS = 3_000;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      console.log(`ChromaDB is reachable at ${url}`);
      return;
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        console.warn(
          `ChromaDB not reachable (attempt ${attempt}/${MAX_RETRIES}): ${err.message}. Retrying in ${RETRY_DELAY_MS / 1000}s...`
        );
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      } else {
        console.error(
          '\n❌ ChromaDB is not running after ' + MAX_RETRIES + ' attempts. Start it in a separate terminal:\n' +
          '   npm run chroma\n' +
          `   (attempted to reach ${url}: ${err.message})\n`
        );
        process.exit(1);
      }
    }
  }
}

/**
 * Re-ingests all docs on every startup so the vector store is always
 * in sync with the docs/ folder — no manual `node ingest.js` needed.
 * Skips ingestion if the collection already has data, to avoid hitting
 * the embedding API rate limit on every restart.
 */
async function ingestDocs() {
  if (!fs.existsSync(DOCS_DIR)) return;
  const files = fs.readdirSync(DOCS_DIR).filter(f => f.toLowerCase().endsWith('.md'));
  if (files.length === 0) return;

  // Check if the collection already has data — if so, skip re-ingestion.
  // This avoids burning embedding API quota on every restart.
  // Run `node ingest.js` manually to force a full re-ingest after doc changes.
  try {
    const chromaUrl = (process.env.CHROMA_URL ?? 'http://localhost:8000').replace('localhost', '127.0.0.1');
    const collectionsRes = await fetch(`${chromaUrl}/api/v2/tenants/default_tenant/databases/default_database/collections`);
    const collections = await collectionsRes.json();
    const docsCollection = Array.isArray(collections) ? collections.find(c => c.name === 'docs') : null;
    if (docsCollection) {
      const countRes = await fetch(`${chromaUrl}/api/v2/tenants/default_tenant/databases/default_database/collections/${docsCollection.id}/count`);
      const count = await countRes.json();
      if (count > 0) {
        console.log(`ChromaDB already has ${count} chunk(s) — skipping ingestion. Run 'node ingest.js' to re-ingest.`);
        return;
      }
    }
  } catch (err) {
    console.warn('Could not check collection count:', err.message);
  }

  console.log(`Ingesting ${files.length} doc(s) into ChromaDB...`);
  const TIMEOUT_MS = 60_000;
  for (const file of files) {
    const filePath = path.join(DOCS_DIR, file);
    try {
      await Promise.race([
        ingestFile(filePath),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`timeout after ${TIMEOUT_MS / 1000}s — embedding API may be rate-limited`)), TIMEOUT_MS)
        ),
      ]);
    } catch (err) {
      console.error(`Ingestion failed for ${file}: ${err.message}`);
    }
  }
  console.log('Ingestion complete.');
}

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
  logLevel: LogLevel.INFO,
});

registerListeners(app);

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});

(async () => {
  try {
    await checkChroma();
    await ingestDocs();   // wait — app doesn't start until data is ready
    await app.start();
    console.log('⚡️ Bolt app started');

    // Runs gap-detect / staleness-detect on a recurring interval in-process,
    // so no separate cron entry or manual `npm run gap-detect` is needed for
    // local dev. Set ENABLE_SCHEDULER=false to disable (e.g. if you're
    // running scheduler.js separately, or via an external cron job instead).
    if (process.env.ENABLE_SCHEDULER !== 'false') {
      startScheduler();
    } else {
      console.log('[scheduler] disabled via ENABLE_SCHEDULER=false');
    }
  } catch (error) {
    console.error('Failed to start app:', error);
    process.exit(1);
  }
})();
