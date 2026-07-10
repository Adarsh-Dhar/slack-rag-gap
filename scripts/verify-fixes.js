#!/usr/bin/env node
// scripts/verify-fixes.js
//
// Standalone smoke test for the infra fixes — run this directly, no Slack
// or network access required. It exercises the *real* modules (store.js,
// with-retry.js, failure-counter.js, openai-client.js), not mocks, so a
// pass here means the actual code path works, not just that a test double
// was satisfied.
//
// Usage:  node scripts/verify-fixes.js
// Exit code 0 = all checks passed, 1 = at least one failed.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TMP = path.join(ROOT, '.verify-tmp');

const results = [];

function record(name, fn) {
  return (async () => {
    const start = Date.now();
    try {
      await fn();
      results.push({ name, ok: true, ms: Date.now() - start });
    } catch (err) {
      results.push({ name, ok: false, ms: Date.now() - start, err });
    }
  })();
}

function runNode(code, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

// ---------------------------------------------------------------------------
// #6 Module-load-time side effects: importing files that talk to the LLM
// must NOT throw when GITHUB_TOKEN is unset. Spawned in a clean child
// process so we can strip the env var even if the parent shell has it set.
// ---------------------------------------------------------------------------
async function testModuleLoadSafety() {
  const modules = ['agent/draft-generator.js', 'agent/llm-caller.js', 'agent/embeddings.js', 'agent/rag.js', 'agent/thread-resolver.js'].filter((m) =>
    fs.existsSync(path.join(ROOT, m)),
  );
  assert.ok(modules.length > 0, 'no LLM-touching modules found to test');

  for (const mod of modules) {
    const env = { ...process.env };
    delete env.GITHUB_TOKEN;
    const { code, stderr } = await runNode(`import(${JSON.stringify(`./${mod}`)}).then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });`, {
      GITHUB_TOKEN: undefined,
    });
    assert.equal(code, 0, `importing ${mod} without GITHUB_TOKEN crashed:\n${stderr}`);
  }
}

// ---------------------------------------------------------------------------
// #3 Race conditions / file locking: fire N concurrent processes that each
// do a read-modify-write (increment a counter) through the real
// withFileLockSync + writeJSONAtomic path. If locking is broken, some
// increments get lost (final count < N) or the file gets corrupted.
// ---------------------------------------------------------------------------
async function testFileLocking() {
  fs.mkdirSync(TMP, { recursive: true });
  const target = path.join(TMP, 'counter.json');
  fs.writeFileSync(target, JSON.stringify({ count: 0 }));

  const N = 25;
  const workerCode = `
    import { withFileLockSync, readJSON, writeJSONAtomic } from ${JSON.stringify(path.join(ROOT, 'agent/store.js'))};
    withFileLockSync(${JSON.stringify(target)}, () => {
      const data = readJSON(${JSON.stringify(target)}, { count: 0 });
      data.count += 1;
      writeJSONAtomic(${JSON.stringify(target)}, data);
    });
  `;

  await Promise.all(Array.from({ length: N }, () => runNode(workerCode)));

  const raw = fs.readFileSync(target, 'utf-8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`counter.json is not valid JSON after ${N} concurrent writers — file corrupted:\n${raw}`);
  }
  assert.equal(parsed.count, N, `expected count=${N} after ${N} concurrent increments, got ${parsed.count} — writes were lost (lock not working)`);
}

// ---------------------------------------------------------------------------
// #4 Retry/backoff: exercise the real withRetry() against a function that
// fails twice then succeeds, and confirm (a) it eventually returns the
// success value and (b) the backoff delays actually grow between attempts.
// Also confirm a permanently-failing call still throws after exhausting
// retries, and that isRetryable=false short-circuits immediately (no wait).
// ---------------------------------------------------------------------------
async function testRetryBackoff() {
  const { withRetry } = await import(path.join(ROOT, 'agent/with-retry.js'));

  // Case A: fails twice, succeeds on 3rd attempt.
  let attempts = 0;
  const delays = [];
  let lastTime = Date.now();
  const result = await withRetry(
    async () => {
      const now = Date.now();
      if (attempts > 0) delays.push(now - lastTime);
      lastTime = now;
      attempts++;
      if (attempts < 3) throw { status: 429 };
      return 'ok';
    },
    { retries: 5, baseDelayMs: 20, isRetryable: () => true, label: 'verify-fixes' },
  );
  assert.equal(result, 'ok', 'withRetry did not return the eventual success value');
  assert.equal(attempts, 3, `expected exactly 3 attempts, got ${attempts}`);
  assert.ok(delays.length === 2, 'expected 2 recorded backoff delays');
  assert.ok(delays[1] >= delays[0], `backoff should grow between attempts, got ${delays[0]}ms then ${delays[1]}ms`);

  // Case B: always fails -> should throw after exhausting retries, not hang.
  let failAttempts = 0;
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          failAttempts++;
          throw { status: 500 };
        },
        { retries: 3, baseDelayMs: 5, isRetryable: () => true, label: 'verify-fixes-fail' },
      ),
    /.*/,
    'withRetry should reject once retries are exhausted',
  );
  assert.equal(failAttempts, 3, `expected exactly 3 attempts before giving up, got ${failAttempts}`);

  // Case C: non-retryable error should fail on the FIRST attempt (no retry loop).
  let nonRetryableAttempts = 0;
  await assert.rejects(() =>
    withRetry(
      async () => {
        nonRetryableAttempts++;
        throw { status: 401 };
      },
      { retries: 5, baseDelayMs: 500, isRetryable: (err) => err.status !== 401, label: 'verify-fixes-401' },
    ),
  );
  assert.equal(nonRetryableAttempts, 1, `non-retryable error should stop after 1 attempt, got ${nonRetryableAttempts}`);
}

// ---------------------------------------------------------------------------
// #7 Observability / dead-letter: confirm recordFailure increments
// consecutiveFailures on repeat failures, and pruneSuccess actually
// removes the entry once the cluster succeeds.
// ---------------------------------------------------------------------------
async function testDeadLetter() {
  const { recordFailure, pruneSuccess } = await import(path.join(ROOT, 'agent/failure-counter.js'));
  const target = path.join(TMP, 'failed-drafts.json');
  if (fs.existsSync(target)) fs.unlinkSync(target);

  const entry = { cluster: 'how do I deploy on Fridays', error: 'boom', lastAttemptAt: new Date().toISOString() };
  recordFailure(target, entry);
  recordFailure(target, entry);
  recordFailure(target, entry);

  const afterFailures = JSON.parse(fs.readFileSync(target, 'utf-8'));
  assert.equal(
    afterFailures[entry.cluster].consecutiveFailures,
    3,
    `expected consecutiveFailures=3 after 3 recordFailure calls, got ${afterFailures[entry.cluster].consecutiveFailures}`,
  );
  assert.ok(afterFailures[entry.cluster].firstSeenAt, 'dead-letter entry missing firstSeenAt');

  pruneSuccess(target, entry.cluster);
  const afterPrune = JSON.parse(fs.readFileSync(target, 'utf-8'));
  assert.ok(!(entry.cluster in afterPrune), 'entry should be removed from dead-letter file after pruneSuccess');
}

// ---------------------------------------------------------------------------
// #5 CI config sanity check — can't actually run GitHub Actions locally,
// but we can confirm the workflow file exists and is shaped correctly
// (would catch e.g. someone accidentally deleting/breaking it).
// ---------------------------------------------------------------------------
async function testCiConfig() {
  const ciPath = path.join(ROOT, '.github/workflows/ci.yml');
  assert.ok(fs.existsSync(ciPath), '.github/workflows/ci.yml is missing');
  const contents = fs.readFileSync(ciPath, 'utf-8');
  assert.match(contents, /on:\s*[\s\S]*push/, 'CI workflow does not trigger on push');
  assert.match(contents, /npm (ci|install)/, 'CI workflow does not install dependencies');
  assert.match(contents, /npm test/, 'CI workflow does not run tests');
  assert.match(contents, /GITHUB_TOKEN/, 'CI workflow does not set a GITHUB_TOKEN for the test step');
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------
async function main() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });

  await record('#6 module-load safety (no crash without GITHUB_TOKEN)', testModuleLoadSafety);
  await record('#3 file locking under concurrency', testFileLocking);
  await record('#4 retry/backoff behavior', testRetryBackoff);
  await record('#7 dead-letter tracking (failure-counter.js)', testDeadLetter);
  await record('#5 CI workflow config sanity', testCiConfig);

  fs.rmSync(TMP, { recursive: true, force: true });

  console.log('\n--- verify-fixes results ---\n');
  let allOk = true;
  for (const r of results) {
    const icon = r.ok ? '✅' : '❌';
    console.log(`${icon} ${r.name}  (${r.ms}ms)`);
    if (!r.ok) {
      allOk = false;
      console.log(`   ${r.err.message ?? r.err}\n`);
    }
  }
  console.log('\n' + (allOk ? 'All checks passed.' : 'Some checks FAILED — see above.'));
  process.exit(allOk ? 0 : 1);
}

main();
