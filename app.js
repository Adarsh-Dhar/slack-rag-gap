import 'dotenv/config';
import { App, LogLevel } from '@slack/bolt';
import fs from 'fs';
import path from 'path';
import log from './agent/logger.js';
import { ingestFile } from './ingest.js';
import { registerListeners } from './listeners/index.js';
import { startScheduler } from './scheduler.js';

const DOCS_DIR = path.join(process.cwd(), 'docs');

/**
 * Fail loudly at startup if required secrets are missing, instead of
 * surfacing a cryptic error deep inside the first request that needs them
 * (e.g. GITHUB_TOKEN missing only showing up as an OpenAIError on first
 * LLM call). This is deliberately just an env-var presence check — see
 * docs on secrets management for how to swap in a real secrets manager
 * (AWS/GCP/Vault/Doppler) without touching anything downstream, since
 * every call site already just reads process.env.X.
 */
function checkRequiredEnv() {
  const required = ['SLACK_APP_TOKEN', 'SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET', 'GITHUB_TOKEN', 'STAKEHOLDER_USER_ID', 'APP_CREATOR_ID'];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    log.fatal({ module: 'app', missing }, 'Missing required env vars');
    process.exit(1);
  }
}

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
      log.info({ module: 'app', url }, 'ChromaDB is reachable');
      return;
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        log.warn(
          { module: 'app', attempt, maxRetries: MAX_RETRIES, err: err.message },
          'ChromaDB not reachable — retrying',
        );
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      } else {
        log.fatal(
          { module: 'app', url, err: err.message, maxRetries: MAX_RETRIES },
          'ChromaDB not running after all retries',
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
  const files = fs.readdirSync(DOCS_DIR).filter((f) => f.toLowerCase().endsWith('.md'));
  if (files.length === 0) return;

  // Check if the collection already has data — if so, skip re-ingestion.
  // This avoids burning embedding API quota on every restart.
  // Run `node ingest.js` manually to force a full re-ingest after doc changes.
  try {
    const chromaUrl = (process.env.CHROMA_URL ?? 'http://localhost:8000').replace('localhost', '127.0.0.1');
    const collectionsRes = await fetch(
      `${chromaUrl}/api/v2/tenants/default_tenant/databases/default_database/collections`,
    );
    const collections = await collectionsRes.json();
    const docsCollection = Array.isArray(collections) ? collections.find((c) => c.name === 'docs') : null;
    if (docsCollection) {
      const countRes = await fetch(
        `${chromaUrl}/api/v2/tenants/default_tenant/databases/default_database/collections/${docsCollection.id}/count`,
      );
      const count = await countRes.json();
      if (count > 0) {
        log.info({ module: 'app', count }, 'ChromaDB collection already populated — skipping ingestion');
        return;
      }
    }
  } catch (err) {
    log.warn({ module: 'app', err: err.message }, 'Could not check collection count');
  }

  log.info({ module: 'app', fileCount: files.length }, 'Ingesting docs into ChromaDB');
  const TIMEOUT_MS = 60_000;
  for (const file of files) {
    const filePath = path.join(DOCS_DIR, file);
    try {
      await Promise.race([
        ingestFile(filePath),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error(`timeout after ${TIMEOUT_MS / 1000}s — embedding API may be rate-limited`)),
            TIMEOUT_MS,
          ),
        ),
      ]);
    } catch (err) {
      log.error({ module: 'app', file, err: err.message }, 'Ingestion failed for file');
    }
  }
  log.info({ module: 'app' }, 'Ingestion complete');
}

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  logLevel: LogLevel.INFO,
});

registerListeners(app);

process.on('unhandledRejection', (reason) => {
  log.error({ module: 'app', err: reason }, 'Unhandled Rejection');
});

(async () => {
  try {
    checkRequiredEnv();
    await checkChroma();
    await ingestDocs(); // wait — app doesn't start until data is ready
    await app.start(3000);
    log.info({ module: 'app' }, 'Bolt app started on port 3000');

    // Runs gap-detect / staleness-detect on a recurring interval in-process,
    // so no separate cron entry or manual `npm run gap-detect` is needed for
    // local dev. Set ENABLE_SCHEDULER=false to disable (e.g. if you're
    // running scheduler.js separately, or via an external cron job instead).
    if (process.env.ENABLE_SCHEDULER !== 'false') {
      startScheduler();
    } else {
      log.info({ module: 'scheduler' }, 'Scheduler disabled via ENABLE_SCHEDULER=false');
    }
    
    // Keep the process alive for HTTP mode
    log.info({ module: 'app' }, 'Server is running - press Ctrl+C to stop');
    
    // Prevent process from exiting in HTTP mode
    await new Promise(() => {}); // Keep alive indefinitely
  } catch (error) {
    log.fatal({ module: 'app', err: error.stack ?? error }, 'Failed to start app');
    process.exit(1);
  }
})();
