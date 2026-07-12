import 'dotenv/config';
import { resetRunSummary, runSummary } from './agent/failure-counter.js';
import log from './agent/logger.js';
import { main as runCodeStalenessDetect } from './code-staleness-detect.js';
import { main as runCommandValidityCheck } from './command-validity-check.js';
import { main as runGapDetect } from './gap-detect.js';
import { main as runOwnerLivenessCheck } from './owner-liveness-check.js';
import { main as runStalenessDetect } from './staleness-detect.js';

// How often to run the batch jobs, in milliseconds. Defaults to 60s for
// local dev; set a longer interval (e.g. 15-30 min) in real deployments —
// running every 60s in production would burn through embedding/LLM quota
// for little benefit, since gap clusters and staleness scores don't change
// that fast.
const INTERVAL_MS = parseInt(process.env.SCHEDULER_INTERVAL_MS, 10) || 60_000;

// Low-frequency jobs run every LOW_FREQ_MULTIPLIER ticks of the main interval.
// E.g. if INTERVAL_MS=60s and LOW_FREQ_MULTIPLIER=30, low-freq jobs run every
// 30 minutes — enough to catch stale docs or departed owners without burning
// API quota on every cycle.
const LOW_FREQ_MULTIPLIER = parseInt(process.env.LOW_FREQ_MULTIPLIER, 10) || 30;

// Per-job "already running" flags. If a tick fires while the previous run
// of that same job is still in flight (e.g. a slow Slack/LLM call), the new
// tick is skipped rather than stacking concurrent runs on top of each other.
const state = {
  'gap-detect': { running: false, fn: runGapDetect },
  'staleness-detect': { running: false, fn: runStalenessDetect },
  'code-staleness-detect': { running: false, fn: runCodeStalenessDetect, lowFreq: true },
  'command-validity-check': { running: false, fn: runCommandValidityCheck, lowFreq: true },
  'owner-liveness-check': { running: false, fn: runOwnerLivenessCheck, lowFreq: true },
};

async function runJob(name) {
  const job = state[name];
  if (job.running) {
    log.debug({ module: 'scheduler', job: name }, 'Job still running from previous tick — skipping');
    return;
  }

  job.running = true;
  const startedAt = Date.now();
  resetRunSummary();
  log.debug({ module: 'scheduler', job: name }, 'Job starting');
  try {
    await job.fn();
    const summary = runSummary();
    log.debug({ module: 'scheduler', job: name, durationMs: Date.now() - startedAt, ...summary }, 'Job finished');
  } catch (err) {
    // A failure in one job must never take down the scheduler or block the
    // other job — log and move on, next tick will try again.
    log.error({ module: 'scheduler', job: name, err: err.stack ?? err }, 'Job failed');
  } finally {
    job.running = false;
  }
}

let tickCount = 0;

async function tick() {
  tickCount++;

  // Run high-frequency jobs every tick
  await runJob('gap-detect');
  await runJob('staleness-detect');

  // Run low-frequency jobs every LOW_FREQ_MULTIPLIER ticks
  if (tickCount % LOW_FREQ_MULTIPLIER === 0) {
    log.debug({ module: 'scheduler', tickCount, lowFreqMultiplier: LOW_FREQ_MULTIPLIER }, 'Running low-frequency jobs');
    await runJob('code-staleness-detect');
    await runJob('command-validity-check');
    await runJob('owner-liveness-check');
  }
}

/**
 * Starts the recurring schedule. Runs one tick shortly after startup (so you
 * don't wait a full interval to see the first result), then every
 * INTERVAL_MS after that.
 *
 * @returns {() => void} stop - call to cancel the schedule (e.g. on shutdown)
 */
export function startScheduler() {
  log.debug({ module: 'scheduler', intervalMs: INTERVAL_MS }, 'Scheduler starting');

  tick();
  const handle = setInterval(tick, INTERVAL_MS);

  return function stop() {
    clearInterval(handle);
    log.debug({ module: 'scheduler' }, 'Scheduler stopped');
  };
}

// Only auto-start when this file is executed directly (`node scheduler.js`),
// not when imported by app.js or tests.
const isMain =
  process.argv[1] && (process.argv[1].endsWith('/scheduler.js') || process.argv[1].endsWith('\\scheduler.js'));
if (isMain) startScheduler();
