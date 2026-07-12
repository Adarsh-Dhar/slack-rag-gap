#!/usr/bin/env node
// scripts/verify-min-hits-threshold.js
//
// Automates this checklist item:
//   "Push a cluster to exactly MIN_HITS_FOR_DRAFT (default 3) — confirm the
//    ping fires on the next tick, not before."
//
// It calls the REAL gap-detect.js main() twice, simulating two scheduler
// ticks, with a real query-log.jsonl mutated in between — exactly what
// scheduler.js does on an interval, minus the wait:
//
//   tick 1: cluster has 2 hits  -> must be skipped, zero Slack pings
//   (append 3rd matching entry) -> must STILL be zero pings (no watcher,
//                                   nothing runs until the next tick)
//   tick 2: cluster has 3 hits  -> must ping (fires pingForExplanation)
//
// What's real:    gap-detect.js, gap-store.js, agent/sme-router.js,
//                  agent/topic-owner.js, agent/thread-resolver.js,
//                  agent/notify-stakeholder.js, agent/embeddings.js — all
//                  run unmodified.
// What's mocked:  the Slack WebClient (@slack/web-api) and OpenAI
//                  embeddings.create, patched at the prototype level (same
//                  technique test/thread-resolver.test.js already uses for
//                  OpenAI) so no real Slack workspace or API key is needed.
// What's required: a real local Chroma server, since gap-store.js talks to
//                  it over HTTP and that's the thing actually being
//                  exercised by the clustering logic. Start it first:
//                    npm run start:chroma
//
// Usage:
//   node scripts/verify-min-hits-threshold.js
//   MIN_HITS_FOR_DRAFT=5 node scripts/verify-min-hits-threshold.js
//
// Exit code 0 = both assertions passed, 1 = something didn't behave as
// expected (details printed, including the failed-drafts.json contents if
// gap-detect swallowed an error internally).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { WebClient } from '@slack/web-api';
import { OpenAI } from 'openai';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const MIN_HITS = parseInt(process.env.MIN_HITS_FOR_DRAFT, 10) || 3;
const TEST_QUESTION = `how do I rotate the payments API key? [verify-run-${randomUUID().slice(0, 8)}]`;
const CHANNEL = 'C0BF8AEMVL7';

// ---------------------------------------------------------------------------
// Mocks — installed on the shared prototypes BEFORE gap-detect.js is
// imported, so the `new WebClient()` / `new OpenAI()` instances it
// constructs at module-load time pick them up. Same trick used by
// test/thread-resolver.test.js for OpenAI.
// ---------------------------------------------------------------------------

const postMessageCalls = [];
const conversationsOpenCalls = [];
const unmockedCalls = [];

WebClient.prototype.apiCall = async function (method, options = {}) {
  switch (method) {
    case 'auth.test':
      return { ok: true, user_id: 'UBOTTEST' };
    case 'conversations.info':
      // Deliberately not incident-shaped, so gap-detect takes the normal
      // (non-incident) path.
      return { ok: true, channel: { id: options.channel, name: 'general-test' } };
    case 'conversations.replies':
      // Only the original message, no human reply -> judgeResolution's
      // fast path returns resolved:false without any LLM call, which is
      // exactly the "ping" path we want to exercise.
      return { ok: true, messages: [{ ts: options.ts, user: 'UASKER', text: TEST_QUESTION }] };
    case 'conversations.open':
      conversationsOpenCalls.push(options);
      return { ok: true, channel: { id: 'DTESTDM' } };
    case 'chat.postMessage':
      postMessageCalls.push(options);
      return { ok: true, ts: `${Date.now() / 1000}` };
    default:
      unmockedCalls.push(method);
      throw new Error(`verify-min-hits-threshold: unmocked Slack method "${method}" — extend the mock or check the code path.`);
  }
};

// Deterministic fake embedding: identical text -> identical vector, so
// clustering behaves predictably without a real OpenAI key. Good enough
// for this test because every log line uses the exact same TEST_QUESTION.
function fakeEmbed(text) {
  const dims = 16;
  const vec = new Array(dims).fill(0);
  for (let i = 0; i < text.length; i++) vec[i % dims] += text.charCodeAt(i);
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
}

const _tempOpenAI = new OpenAI({ apiKey: 'test' });
Object.getPrototypeOf(_tempOpenAI.embeddings).create = async function ({ input }) {
  return { data: [{ embedding: fakeEmbed(input) }] };
};

// ---------------------------------------------------------------------------
// Isolated scratch working directory, so this never touches the project's
// real query-log.jsonl / resolved-gaps.json / failed-drafts.json.
// ---------------------------------------------------------------------------

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gap-detect-verify-'));
const QUERY_LOG = path.join(scratchDir, 'query-log.jsonl');

fs.writeFileSync(path.join(scratchDir, 'resolved-gaps.json'), '[]');
fs.writeFileSync(path.join(scratchDir, 'process-owners.json'), '{}');
fs.writeFileSync(path.join(scratchDir, 'doc-owners.json'), '{}');
fs.writeFileSync(QUERY_LOG, '');

process.env.GITHUB_TOKEN = process.env.GITHUB_TOKEN || 'test-token';
process.env.SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || 'xoxb-test';
process.env.STAKEHOLDER_USER_ID = 'UFALLBACKTEST';
process.env.MIN_HITS_FOR_DRAFT = String(MIN_HITS);
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'debug';

process.chdir(scratchDir);

function appendQuery(threadTs) {
  const line = {
    question: TEST_QUESTION,
    hasResults: false,
    channel: CHANNEL,
    thread_ts: threadTs,
    timestamp: new Date().toISOString(),
  };
  fs.appendFileSync(QUERY_LOG, `${JSON.stringify(line)}\n`);
}

function readFailedDrafts() {
  const p = path.join(scratchDir, 'failed-drafts.json');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

async function main() {
  console.log(`Scratch dir: ${scratchDir}`);
  console.log(`MIN_HITS_FOR_DRAFT: ${MIN_HITS}`);
  console.log(`Test question: ${TEST_QUESTION}\n`);

  let gapDetect;
  try {
    gapDetect = await import(path.join(ROOT, 'gap-detect.js'));
  } catch (err) {
    console.error('Failed to import gap-detect.js:', err.message);
    process.exit(1);
  }

  // --- Tick 1: hitCount = MIN_HITS - 1 (below threshold) ------------------
  for (let i = 0; i < MIN_HITS - 1; i++) appendQuery(`1000.000${i + 1}`);

  console.log(`Tick 1: wrote ${MIN_HITS - 1} matching unanswered queries. Running gap-detect...`);
  try {
    await gapDetect.main();
  } catch (err) {
    console.error('gap-detect.main() threw on tick 1:', err);
    process.exit(1);
  }

  assert.equal(
    postMessageCalls.length,
    0,
    `Expected 0 Slack messages after tick 1 (below threshold), got ${postMessageCalls.length}`,
  );
  console.log('  PASS — below threshold, no ping sent.\n');

  // --- Push to exactly MIN_HITS, but do NOT run a tick yet -----------------
  appendQuery('1000.0099');
  console.log(`Pushed cluster to exactly ${MIN_HITS} hits (appended to query-log.jsonl only).`);

  assert.equal(
    postMessageCalls.length,
    0,
    `Expected 0 Slack messages immediately after reaching the threshold (before the next tick), got ${postMessageCalls.length}`,
  );
  console.log('  PASS — reaching the threshold on disk does not fire anything by itself (no file watcher).\n');

  // --- Tick 2: hitCount = MIN_HITS (at threshold) --------------------------
  console.log('Tick 2: running gap-detect again (this is "the next tick")...');
  try {
    await gapDetect.main();
  } catch (err) {
    console.error('gap-detect.main() threw on tick 2:', err);
    process.exit(1);
  }

  if (postMessageCalls.length === 0) {
    console.error('  FAIL — expected a ping on tick 2, got none.');
    const failed = readFailedDrafts();
    if (failed) {
      console.error('  failed-drafts.json contents (gap-detect caught an internal error):');
      console.error(JSON.stringify(failed, null, 2));
    }
    if (unmockedCalls.length) {
      console.error(`  Unmocked Slack methods were called: ${unmockedCalls.join(', ')}`);
    }
    process.exit(1);
  }

  // pingForExplanation sends exactly two messages: an in-thread reply and a DM.
  assert.equal(postMessageCalls.length, 2, `Expected exactly 2 chat.postMessage calls (in-thread + DM), got ${postMessageCalls.length}`);
  assert.equal(conversationsOpenCalls.length, 1, 'Expected conversations.open to be called once, to open the DM');

  const mentionsQuestion = postMessageCalls.some((m) => m.text?.includes(TEST_QUESTION));
  assert.ok(mentionsQuestion, 'Expected at least one message to reference the test question');

  const mentionsHitCount = postMessageCalls.some((m) => JSON.stringify(m).includes(String(MIN_HITS)));
  assert.ok(mentionsHitCount, `Expected the ping to reference the hit count (${MIN_HITS})`);

  console.log('  PASS — ping fired on the next tick, referencing the question and hit count.\n');

  console.log('ALL CHECKS PASSED ✅');
  process.exit(0);
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});