import 'dotenv/config';
import { resetRunSummary, runSummary } from './agent/failure-counter.js';
import log from './agent/logger.js';
import { main as runGapDetect } from './gap-detect.js';
import { main as runStalenessDetect } from './staleness-detect.js';

// How often to run the batch jobs, in milliseconds. Defaults to 60s for
// local dev; set a longer interval (e.g. 15-30 min) in real deployments —
// running every 60s in production would burn through embedding/LLM quota
// for little benefit, since gap clusters and staleness scores don't change
// that fast.
const INTERVAL_MS = parseInt(process.env.SCHEDULER_INTERVAL_MS, 10) || 60_000;

// Per-job "already running" flags. If a tick fires while the previous run
// of that same job is still in flight (e.g. a slow Slack/LLM call), the new
// tick is skipped rather than stacking concurrent runs on top of each other.
const state = {
  'gap-detect': { running: false, fn: runGapDetect },
  'staleness-detect': { running: false, fn: runStalenessDetect },
};

async function runJob(name) {
  const job = state[name];
  if (job.running) {
    log.info({ module: 'scheduler', job: name }, 'Job still running from previous tick — skipping');
    return;
  }

  job.running = true;
  const startedAt = Date.now();
  resetRunSummary();
  log.info({ module: 'scheduler', job: name }, 'Job starting');
  try {
    await job.fn();
    const summary = runSummary();
    log.info({ module: 'scheduler', job: name, durationMs: Date.now() - startedAt, ...summary }, 'Job finished');
  } catch (err) {
    // A failure in one job must never take down the scheduler or block the
    // other job — log and move on, next tick will try again.
    log.error({ module: 'scheduler', job: name, err: err.stack ?? err }, 'Job failed');
  } finally {
    job.running = false;
  }
}

async function tick() {
  // Run sequentially: both jobs hit the same Slack/LLM/Chroma resources,
  // and staleness-detect's DMs are lower priority than fresh gap drafts.
  await runJob('gap-detect');
  await runJob('staleness-detect');
}

/**
 * Starts the recurring schedule. Runs one tick shortly after startup (so you
 * don't wait a full interval to see the first result), then every
 * INTERVAL_MS after that.
 *
 * @returns {() => void} stop - call to cancel the schedule (e.g. on shutdown)
 */
export function startScheduler() {
  log.info({ module: 'scheduler', intervalMs: INTERVAL_MS }, 'Scheduler starting');

  tick();
  const handle = setInterval(tick, INTERVAL_MS);

  return function stop() {
    clearInterval(handle);
    log.info({ module: 'scheduler' }, 'Scheduler stopped');
  };
}

// Only auto-start when this file is executed directly (`node scheduler.js`),
// not when imported by app.js or tests.
const isMain =
  process.argv[1] && (process.argv[1].endsWith('/scheduler.js') || process.argv[1].endsWith('\\scheduler.js'));
if (isMain) startScheduler();
