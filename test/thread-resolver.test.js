/**
 * Tests for judgeFollowUp() in agent/thread-resolver.js.
 *
 * Mocking strategy: patch the OpenAI Completions prototype directly before
 * each call. ESM module instances share the same prototype object, so patching
 * it intercepts all calls the module makes.
 *
 * Ledger isolation: judgeFollowUp accepts an optional ledgerPath param.
 * Every test passes a fresh tmp path so the real doc-usage.json is never
 * touched — a crash mid-test cannot corrupt production data.
 */

import 'dotenv/config';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import fc from 'fast-check';

import { OpenAI } from 'openai';
import { judgeFollowUp } from '../agent/thread-resolver.js';

// Get the Completions prototype so we can patch create() on it
const _tempOpenAI = new OpenAI({ apiKey: 'test' });
const CompletionsProto = Object.getPrototypeOf(_tempOpenAI.chat.completions);
const _originalCreate = CompletionsProto.create;

function tmpLedgerPath() {
  return path.join(os.tmpdir(), `test-ledger-${randomUUID()}.json`);
}

async function withMockedLLM(responseObj, callback) {
  CompletionsProto.create = async function () {
    return { choices: [{ message: { content: JSON.stringify(responseObj) } }] };
  };
  try {
    return await callback();
  } finally {
    CompletionsProto.create = _originalCreate;
  }
}

async function withThrowingLLM(error, callback) {
  CompletionsProto.create = async function () { throw error; };
  try {
    return await callback();
  } finally {
    CompletionsProto.create = _originalCreate;
  }
}

async function withBadJSONLLM(badContent, callback) {
  CompletionsProto.create = async function () {
    return { choices: [{ message: { content: badContent } }] };
  };
  try {
    return await callback();
  } finally {
    CompletionsProto.create = _originalCreate;
  }
}

describe('thread-resolver / judgeFollowUp', () => {

  // Feature: usage-staleness-and-correction-loop, Property 4: Zero-Reply Follow-Up Returns Safe Default
  // Validates: Requirements 2.2
  test('Property 4: Zero-Reply Returns Safe Default', async () => {
    await fc.assert(fc.asyncProperty(
      fc.string({ minLength: 0, maxLength: 100 }),
      fc.array(
        fc.string({ minLength: 1, maxLength: 30 }).map(s => (s.replace(/[^a-z0-9]/gi, 'x') || 'doc') + '.md'),
        { minLength: 0, maxLength: 5 }
      ),
      async (question, sources) => {
        let llmCalled = false;
        const orig = CompletionsProto.create;
        CompletionsProto.create = async function () {
          llmCalled = true;
          return { choices: [{ message: { content: '{}' } }] };
        };
        try {
          const result = await judgeFollowUp(question, sources, []);
          assert.equal(result.label, 'resolved');
          assert.equal(result.correctedText, null);
          assert.deepEqual(result.correctedSources, []);
          assert.equal(llmCalled, false, 'LLM must NOT be called for empty replies');
        } finally {
          CompletionsProto.create = orig;
        }
      }
    ), { numRuns: 100 });
  });

  // Feature: usage-staleness-and-correction-loop, Property 5: Invalid LLM Response Returns Safe Default
  // Validates: Requirements 2.4
  test('Property 5: Invalid LLM Response Returns Safe Default', async () => {
    const SAFE_DEFAULT = { label: 'resolved', correctedText: null, correctedSources: [] };
    const dummyReplies = [{ user: 'u1', text: 'some reply' }];

    await fc.assert(fc.asyncProperty(
      fc.string({ minLength: 1 }).filter(s => {
        try { JSON.parse(s); return false; } catch { return true; }
      }),
      async (badContent) => {
        const result = await withBadJSONLLM(badContent, () =>
          judgeFollowUp('q', ['doc.md'], dummyReplies, null, tmpLedgerPath())
        );
        assert.deepEqual(result, SAFE_DEFAULT);
      }
    ), { numRuns: 50 });

    const invalidLabels = ['', 'unknown', 'error', 'yes', 'no', 'maybe', '123'];
    for (const label of invalidLabels) {
      const result = await withMockedLLM(
        { label, corrected_text: null, corrected_sources: [] },
        () => judgeFollowUp('q', ['doc.md'], dummyReplies, null, tmpLedgerPath())
      );
      assert.deepEqual(result, SAFE_DEFAULT, `Expected safe default for invalid label "${label}"`);
    }

    await fc.assert(fc.asyncProperty(
      fc.string({ minLength: 1, maxLength: 50 }),
      async (errMsg) => {
        const result = await withThrowingLLM(new Error(errMsg), () =>
          judgeFollowUp('q', ['doc.md'], dummyReplies, null, tmpLedgerPath())
        );
        assert.deepEqual(result, SAFE_DEFAULT);
      }
    ), { numRuns: 50 });
  });

  // Feature: usage-staleness-and-correction-loop, Property 6: Follow-Up Label Increments followUpCount
  // Validates: Requirements 2.5
  test('Property 6: Follow-Up Label Increments followUpCount for All Sources', async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(
        fc.string({ minLength: 1, maxLength: 20 }).map(s => (s.replace(/[^a-z0-9]/gi, 'x') || 'doc') + '.md'),
        { minLength: 1, maxLength: 5 }
      ).map(arr => [...new Set(arr)]).filter(arr => arr.length > 0),
      async (sources) => {
        const ledgerPath = tmpLedgerPath();
        try {
          const result = await withMockedLLM(
            { label: 'follow-up-question', corrected_text: null, corrected_sources: [] },
            () => judgeFollowUp('q', sources, [{ user: 'u1', text: 'follow-up reply' }], null, ledgerPath)
          );

          assert.equal(result.label, 'follow-up-question');
          assert.ok(fs.existsSync(ledgerPath), 'Ledger file should exist after follow-up');
          const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf-8'));

          for (const src of sources) {
            assert.ok(src in ledger, `Ledger should have entry for ${src}`);
            assert.equal(ledger[src].followUpCount, 1, `followUpCount should be 1 for ${src}`);
            assert.equal(ledger[src].correctionCount, 0, `correctionCount should be 0 for ${src}`);
          }
        } finally {
          if (fs.existsSync(ledgerPath)) fs.unlinkSync(ledgerPath);
        }
      }
    ), { numRuns: 50 });
  });

  // Feature: usage-staleness-and-correction-loop, Property 7: Correction Label Increments Both Counts
  // Validates: Requirements 2.6
  test('Property 7: Correction Label Increments Both Counts (non-empty correctedSources)', async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(
        fc.string({ minLength: 1, maxLength: 20 }).map(s => (s.replace(/[^a-z0-9]/gi, 'x') || 'src') + '.md'),
        { minLength: 1, maxLength: 4 }
      ).map(arr => [...new Set(arr)]).filter(arr => arr.length > 0),
      fc.array(
        fc.string({ minLength: 1, maxLength: 20 }).map(s => (s.replace(/[^a-z0-9]/gi, 'x') || 'cor') + '-corrected.md'),
        { minLength: 1, maxLength: 3 }
      ).map(arr => [...new Set(arr)]).filter(arr => arr.length > 0),
      async (sources, correctedSources) => {
        const disjointCorrected = correctedSources.filter(s => !sources.includes(s));
        if (disjointCorrected.length === 0) return;

        const ledgerPath = tmpLedgerPath();
        try {
          const result = await withMockedLLM(
            { label: 'correction', corrected_text: 'the correction', corrected_sources: disjointCorrected },
            () => judgeFollowUp('q', sources, [{ user: 'u1', text: 'actually that is wrong' }], null, ledgerPath)
          );

          assert.equal(result.label, 'correction');
          const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf-8'));

          for (const src of disjointCorrected) {
            assert.ok(src in ledger, `Ledger should have entry for corrected source ${src}`);
            assert.equal(ledger[src].correctionCount, 1, `correctionCount should be 1 for ${src}`);
            assert.equal(ledger[src].followUpCount, 1, `followUpCount should be 1 for ${src}`);
          }
          for (const src of sources) {
            if (!disjointCorrected.includes(src)) {
              assert.ok(!(src in ledger), `Sources-only entry ${src} should not be in ledger`);
            }
          }
        } finally {
          if (fs.existsSync(ledgerPath)) fs.unlinkSync(ledgerPath);
        }
      }
    ), { numRuns: 50 });
  });

  test('Property 7: Correction Label Falls Back to sources When correctedSources Is Empty', async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(
        fc.string({ minLength: 1, maxLength: 20 }).map(s => (s.replace(/[^a-z0-9]/gi, 'x') || 'doc') + '.md'),
        { minLength: 1, maxLength: 5 }
      ).map(arr => [...new Set(arr)]).filter(arr => arr.length > 0),
      async (sources) => {
        const ledgerPath = tmpLedgerPath();
        try {
          const result = await withMockedLLM(
            { label: 'correction', corrected_text: 'fallback correction', corrected_sources: [] },
            () => judgeFollowUp('q', sources, [{ user: 'u1', text: 'actually wrong' }], null, ledgerPath)
          );

          assert.equal(result.label, 'correction');
          assert.deepEqual(result.correctedSources, []);
          const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf-8'));

          for (const src of sources) {
            assert.ok(src in ledger, `Ledger should have entry for source ${src} (fallback)`);
            assert.equal(ledger[src].correctionCount, 1, `correctionCount should be 1 for ${src}`);
            assert.equal(ledger[src].followUpCount, 1, `followUpCount should be 1 for ${src}`);
          }
        } finally {
          if (fs.existsSync(ledgerPath)) fs.unlinkSync(ledgerPath);
        }
      }
    ), { numRuns: 50 });
  });

});
