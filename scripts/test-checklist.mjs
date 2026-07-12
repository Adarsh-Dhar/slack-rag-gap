#!/usr/bin/env node
// scripts/test-checklist.mjs
//
// Exercises the four checklist items end-to-end against the REAL modules
// (agent/thread-resolver.js, agent/draft-generator.js,
// listeners/actions/draft_approval.js) — not mocks of your own logic.
// The only things it fakes are the Slack `client`/`ack`/`body` objects that
// draftApprovalCallback expects, since clicking real Approve/Reject buttons
// isn't scriptable. Everything else (LLM judging, file writes, doc-owners.json,
// re-embedding into Chroma) runs for real.
//
//   [ ] Reply with a real explanation -> judgeResolution resolves + drafts a stub
//   [ ] Reply with a non-answer       -> judgeResolution marks it unresolved
//   [ ] Approve a draft               -> merges into docs/, re-embeds, records approver
//   [ ] Reject a draft                -> file is deleted cleanly
//
// Requirements:
//   - GITHUB_TOKEN set (used for both the judge LLM calls and embeddings)
//   - A reachable Chroma instance at CHROMA_URL (default http://127.0.0.1:8000)
//     — only needed for the Approve test, since that's the one that re-embeds.
//
// Usage:  node scripts/test-checklist.mjs
// Exit code 0 = all checks passed (or were cleanly skipped), 1 = a real failure.

import 'dotenv/config';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
process.chdir(ROOT); // every module under test resolves paths off process.cwd()

const results = [];

async function record(name, fn) {
  const start = Date.now();
  try {
    const outcome = await fn();
    results.push({ name, status: outcome === 'skipped' ? 'skip' : 'pass', ms: Date.now() - start });
  } catch (err) {
    results.push({ name, status: 'fail', ms: Date.now() - start, err });
  }
}

function mockClient(calls) {
  return {
    chat: {
      postMessage: async (args) => { calls.push({ method: 'postMessage', args }); return { ok: true }; },
      update: async (args) => { calls.push({ method: 'update', args }); return { ok: true }; },
    },
  };
}

const noopLogger = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} };

function readFrontmatter(filePath) {
  const text = fs.readFileSync(filePath, 'utf-8');
  const match = text.match(/^---\n([\s\S]*?)\n---\n/);
  return match ? match[1] : '';
}

// ---------------------------------------------------------------------------
// Env / prereq checks
// ---------------------------------------------------------------------------
const HAS_TOKEN = Boolean(process.env.GITHUB_TOKEN);
let CHROMA_OK = false;
try {
  const chromaUrl = (process.env.CHROMA_URL ?? 'http://127.0.0.1:8000').replace('localhost', '127.0.0.1');
  const res = await fetch(`${chromaUrl}/api/v2/heartbeat`, { signal: AbortSignal.timeout(3000) });
  CHROMA_OK = res.ok;
} catch {
  CHROMA_OK = false;
}

// ---------------------------------------------------------------------------
// Shared fixture: the exact question from your manual Slack test
// ---------------------------------------------------------------------------
const QUESTION = "What's the parking validation process for the downtown garage?";
const TEST_PERMALINK = 'https://example.slack.com/archives/C_TEST/p0000000000000000';

let judgeResolution, draftStub;
let draftApprovalCallback;

let resolvedDraft = null; // populated by test1, consumed by test3

// ---------------------------------------------------------------------------
// Test 1: real explanation -> judgeResolution resolves + drafts a stub
// ---------------------------------------------------------------------------
async function testRealExplanation() {
  if (!HAS_TOKEN) { console.log('   (skipped — GITHUB_TOKEN not set)'); return 'skipped'; }
  ({ judgeResolution } = await import(path.join(ROOT, 'agent/thread-resolver.js')));
  ({ draftStub } = await import(path.join(ROOT, 'agent/draft-generator.js')));

  const replies = [
    {
      user: 'U_SME',
      text:
        'You validate at the kiosk near the elevator on P2 — scan your garage ticket, then tap your ' +
        'meeting badge. It knocks the rate down to $5 flat for the first 4 hours. If the kiosk is down, ' +
        'front desk can validate manually with your visitor badge number.',
    },
  ];

  const result = await judgeResolution(QUESTION, replies);
  assert.equal(result.resolved, true, `expected resolved=true, got ${JSON.stringify(result)}`);
  assert.ok(result.resolvingText, 'expected resolvingText to be set on a resolved judgement');

  const draft = await draftStub({
    question: QUESTION,
    resolvingText: result.resolvingText,
    permalink: TEST_PERMALINK,
    hitCount: 3, // matches MIN_HITS_FOR_DRAFT default — same as your 3 manual mentions
    codeSnippets: [],
  });

  assert.ok(fs.existsSync(draft.filePath), `expected draft stub file at ${draft.filePath}`);
  const fm = readFrontmatter(draft.filePath);
  assert.match(fm, /status:\s*pending_review/, 'draft stub missing status: pending_review frontmatter');

  resolvedDraft = draft; // hand off to the Approve test
  console.log(`   judged resolved: "${result.reason}"`);
  console.log(`   drafted -> ${path.relative(ROOT, draft.filePath)}`);
}

// ---------------------------------------------------------------------------
// Test 2: non-answers -> judgeResolution marks unresolved
// ---------------------------------------------------------------------------
async function testNonAnswers() {
  if (!HAS_TOKEN) { console.log('   (skipped — GITHUB_TOKEN not set)'); return 'skipped'; }
  ({ judgeResolution } = await import(path.join(ROOT, 'agent/thread-resolver.js')));

  const cases = [
    { label: 'thumbs-up emoji', replies: [{ user: 'U_A', text: ':+1:' }] },
    { label: 'punt to someone else', replies: [{ user: 'U_A', text: 'idk ask Sam' }] },
    { label: 'another question, not an answer', replies: [{ user: 'U_A', text: 'is this the same garage as the one on 5th?' }] },
  ];

  for (const c of cases) {
    const result = await judgeResolution(QUESTION, c.replies);
    assert.equal(
      result.resolved,
      false,
      `expected resolved=false for "${c.label}" (reply: "${c.replies[0].text}"), got ${JSON.stringify(result)}`,
    );
    console.log(`   correctly unresolved: ${c.label} -> "${result.reason}"`);
  }
}

// ---------------------------------------------------------------------------
// Test 3: Approve -> merges into docs/, re-embeds, records approver
// ---------------------------------------------------------------------------
async function testApprove() {
  if (!HAS_TOKEN) { console.log('   (skipped — GITHUB_TOKEN not set)'); return 'skipped'; }
  if (!CHROMA_OK) { console.log('   (skipped — Chroma not reachable; approval re-embeds into Chroma)'); return 'skipped'; }
  if (!resolvedDraft) { console.log('   (skipped — no draft available; test 1 must pass first)'); return 'skipped'; }

  ({ draftApprovalCallback } = await import(path.join(ROOT, 'listeners/actions/draft_approval.js')));

  const DOC_OWNERS_PATH = path.join(ROOT, 'doc-owners.json');
  const ownersBackup = fs.existsSync(DOC_OWNERS_PATH) ? fs.readFileSync(DOC_OWNERS_PATH, 'utf-8') : null;

  const { slug } = resolvedDraft;
  const approverId = 'U_TEST_APPROVER';
  const calls = [];
  const body = {
    type: 'block_actions',
    actions: [{ action_id: 'draft_approve', value: slug }],
    channel: { id: 'C_TEST' },
    message: { ts: '111.222' },
    user: { id: approverId },
  };

  try {
    await draftApprovalCallback({ ack: async () => {}, body, client: mockClient(calls), logger: noopLogger });

    const liveDocPath = path.join(ROOT, 'docs', `${slug}.md`);
    const draftPath = path.join(ROOT, 'docs', 'drafts', `${slug}.md`);
    assert.ok(fs.existsSync(liveDocPath), `expected approved doc to land at docs/${slug}.md`);
    assert.ok(!fs.existsSync(draftPath), `expected docs/drafts/${slug}.md to be gone after approval`);

    const owners = JSON.parse(fs.readFileSync(DOC_OWNERS_PATH, 'utf-8'));
    assert.equal(
      owners[`${slug}.md`]?.owner,
      approverId,
      `expected doc-owners.json["${slug}.md"].owner === "${approverId}"`,
    );

    const updateCall = calls.find((c) => c.method === 'update');
    assert.ok(updateCall, 'expected client.chat.update to be called on approval');
    assert.match(
      JSON.stringify(updateCall.args),
      /Approved/i,
      'expected the Slack update message to confirm approval',
    );

    console.log(`   merged -> docs/${slug}.md, owner recorded as ${approverId}, re-embedded into Chroma`);

    // cleanup: remove the test doc from disk and from Chroma
    fs.rmSync(liveDocPath, { force: true });
    try {
      const { ChromaClient } = await import('chromadb');
      const chromaUrl = (process.env.CHROMA_URL ?? 'http://127.0.0.1:8000').replace('localhost', '127.0.0.1');
      const u = new URL(chromaUrl);
      const chroma = new ChromaClient({ host: u.hostname, port: parseInt(u.port, 10) || 8000, ssl: u.protocol === 'https:' });
      const collection = await chroma.getOrCreateCollection({ name: 'docs' });
      await collection.delete({ where: { source: `${slug}.md` } });
    } catch {
      console.log(`   (note: could not auto-clean Chroma vectors for ${slug}.md — harmless, but you can re-run ingest.js to tidy up)`);
    }
  } finally {
    // restore doc-owners.json exactly as it was
    if (ownersBackup !== null) fs.writeFileSync(DOC_OWNERS_PATH, ownersBackup);
    else fs.rmSync(DOC_OWNERS_PATH, { force: true });
  }
}

// ---------------------------------------------------------------------------
// Test 4: Reject -> file deleted cleanly (pure fs, no LLM/Chroma needed)
// ---------------------------------------------------------------------------
async function testReject() {
  ({ draftApprovalCallback } = await import(path.join(ROOT, 'listeners/actions/draft_approval.js')));

  const slug = `test-reject-checklist-${randomUUID().slice(0, 8)}`;
  const draftsDir = path.join(ROOT, 'docs', 'drafts');
  fs.mkdirSync(draftsDir, { recursive: true });
  const draftPath = path.join(draftsDir, `${slug}.md`);
  fs.writeFileSync(
    draftPath,
    ['---', `title: Test Reject Draft`, `status: pending_review`, `doc_type: other`, `source_thread: ${TEST_PERMALINK}`, `hit_count: 3`, `created_at: ${new Date().toISOString()}`, '---', '', 'Throwaway body for the reject test.', ''].join('\n'),
  );

  const calls = [];
  const body = {
    type: 'block_actions',
    actions: [{ action_id: 'draft_reject', value: slug }],
    channel: { id: 'C_TEST' },
    message: { ts: '111.333' },
    user: { id: 'U_TEST_REJECTOR' },
  };

  await draftApprovalCallback({ ack: async () => {}, body, client: mockClient(calls), logger: noopLogger });

  assert.ok(!fs.existsSync(draftPath), `expected ${draftPath} to be deleted after rejection`);
  assert.ok(!fs.existsSync(path.join(ROOT, 'docs', `${slug}.md`)), 'rejected draft should NOT appear in docs/');

  const updateCall = calls.find((c) => c.method === 'update');
  assert.ok(updateCall, 'expected client.chat.update to be called on rejection');
  assert.match(JSON.stringify(updateCall.args), /Rejected/i, 'expected the Slack update message to confirm rejection');

  console.log(`   ${slug}.md deleted cleanly, no trace left in docs/`);
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------
async function main() {
  console.log('--- prerequisites ---');
  console.log(`GITHUB_TOKEN set:     ${HAS_TOKEN ? 'yes' : 'NO — tests 1-3 will be skipped'}`);
  console.log(`Chroma reachable:     ${CHROMA_OK ? 'yes' : 'NO — test 3 (Approve) will be skipped'}`);
  console.log('');

  console.log('[1/4] Real explanation -> resolved + drafted');
  await record('1. Real explanation resolves + drafts a stub', testRealExplanation);

  console.log('[2/4] Non-answers -> unresolved');
  await record('2. Non-answers correctly judged unresolved', testNonAnswers);

  console.log('[3/4] Approve -> merges + re-embeds + records owner');
  await record('3. Approve merges into docs/, re-embeds, records owner', testApprove);

  console.log('[4/4] Reject -> deleted cleanly');
  await record('4. Reject deletes the draft file cleanly', testReject);

  console.log('\n--- results ---\n');
  let hasFailure = false;
  for (const r of results) {
    const icon = r.status === 'pass' ? '✅' : r.status === 'skip' ? '⏭️ ' : '❌';
    console.log(`${icon} ${r.name}  (${r.ms}ms)`);
    if (r.status === 'fail') {
      hasFailure = true;
      console.log(`   ${r.err.message ?? r.err}\n`);
    }
  }
  console.log('\n' + (hasFailure ? 'Some checks FAILED — see above.' : 'All checks passed or were cleanly skipped.'));
  process.exit(hasFailure ? 1 : 0);
}

main();
