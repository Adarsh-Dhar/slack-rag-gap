/**
 * Tests for judgeFollowUp() in agent/thread-resolver.js.
 *
 * Mocking strategy: Since thread-resolver.js creates the `openai` instance at
 * module level and doesn't export it, and mock.module is not available in this
 * Node version, we patch the OpenAI Completions prototype directly. Because ESM
 * module instances share the same prototype object, patching it before calling
 * judgeFollowUp intercepts all calls the module makes.
 *
 * Ledger verification: judgeFollowUp writes to the default doc-usage.json path.
 * Each test backs up and restores doc-usage.json around its execution.
 */

// dotenv must be the first import so GITHUB_TOKEN is set before OpenAI is constructed
import 'dotenv/config';

import { test, describe, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import fc from 'fast-check';

import { OpenAI } from 'openai';
import { judgeFollowUp } from '../agent/thread-resolver.js';

const PROJECT_ROOT = new URL('..', import.meta.url).pathname;
const DEFAULT_LEDGER_PATH = path.join(PROJECT_ROOT, 'doc-usage.json');

// Get the Completions prototype so we can patch create() on it
const _tempOpenAI = new OpenAI({ apiKey: 'test' });
const CompletionsProto = Object.getPrototypeOf(_tempOpenAI.chat.completions);
const _originalCreate = CompletionsProto.create;

/**
 * Temporarily replaces CompletionsProto.create with a mock that returns the
 * given LLM response object. Restores after the async callback completes.
 */
async function withMockedLLM(responseObj, callback) {
  CompletionsProto.create = async function () {
    return {
      choices: [{ message: { content: JSON.stringify(responseObj) } }]
    };
  };
  try {
    return await callback();
  } finally {
    CompletionsProto.create = _originalCreate;
  }
}

/**
 * Makes CompletionsProto.create throw (simulates LLM errors / parse failures).
 */
async function withThrowingLLM(error, callback) {
  CompletionsProto.create = async function () {
    throw error;
  };
  try {
    return await callback();
  } finally {
    CompletionsProto.create = _originalCreate;
  }
}

/**
 * Makes CompletionsProto.create return non-JSON content.
 */
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

// Backup/restore helpers for doc-usage.json
function backupLedger() {
  if (fs.existsSync(DEFAULT_LEDGER_PATH)) {
    const backup = DEFAULT_LEDGER_PATH + '.test-bak-' + randomUUID();
    fs.copyFileSync(DEFAULT_LEDGER_PATH, backup);
    return backup;
  }
  return null;
}

function restoreLedger(backup) {
  if (backup && fs.existsSync(backup)) {
    fs.copyFileSync(backup, DEFAULT_LEDGER_PATH);
    fs.unlinkSync(backup);
  } else if (fs.existsSync(DEFAULT_LEDGER_PATH)) {
    fs.unlinkSync(DEFAULT_LEDGER_PATH);
  }
  const tmp = DEFAULT_LEDGER_PATH + '.tmp';
  if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
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
        // Track if LLM is called — it should NOT be
        let llmCalled = false;
        const orig = CompletionsProto.create;
        CompletionsProto.create = async function () {
          llmCalled = true;
          return { choices: [{ message: { content: '{}' } }] };
        };

        try {
          const result = await judgeFollowUp(question, sources, []);
          assert.equal(result.label, 'resolved', 'label must be "resolved"');
          assert.equal(result.correctedText, null, 'correctedText must be null');
          assert.deepEqual(result.correctedSources, [], 'correctedSources must be []');
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

    // Sub-case A: non-JSON content
    await fc.assert(fc.asyncProperty(
      // Strings that are not valid JSON
      fc.string({ minLength: 1 }).filter(s => {
        try { JSON.parse(s); return false; } catch { return true; }
      }),
      async (badContent) => {
        const result = await withBadJSONLLM(badContent, () =>
          judgeFollowUp('q', ['doc.md'], dummyReplies)
        );
        assert.deepEqual(result, SAFE_DEFAULT, `Expected safe default for non-JSON "${badContent}"`);
      }
    ), { numRuns: 50 });

    // Sub-case B: JSON with invalid label
    const invalidLabels = ['', 'unknown', 'error', 'yes', 'no', 'maybe', '123'];
    for (const label of invalidLabels) {
      const result = await withMockedLLM(
        { label, corrected_text: null, corrected_sources: [] },
        () => judgeFollowUp('q', ['doc.md'], dummyReplies)
      );
      assert.deepEqual(result, SAFE_DEFAULT,
        `Expected safe default for invalid label "${label}"`
      );
    }

    // Sub-case C: LLM throws
    await fc.assert(fc.asyncProperty(
      fc.string({ minLength: 1, maxLength: 50 }),
      async (errMsg) => {
        const result = await withThrowingLLM(new Error(errMsg), () =>
          judgeFollowUp('q', ['doc.md'], dummyReplies)
        );
        assert.deepEqual(result, SAFE_DEFAULT, `Expected safe default when LLM throws`);
      }
    ), { numRuns: 50 });
  });

  // Feature: usage-staleness-and-correction-loop, Property 6: Follow-Up Label Increments followUpCount for All Sources
  // Validates: Requirements 2.5
  test('Property 6: Follow-Up Label Increments followUpCount for All Sources', async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(
        fc.string({ minLength: 1, maxLength: 20 }).map(s => (s.replace(/[^a-z0-9]/gi, 'x') || 'doc') + '.md'),
        { minLength: 1, maxLength: 5 }
      ).map(arr => [...new Set(arr)]).filter(arr => arr.length > 0),
      async (sources) => {
        const backup = backupLedger();
        // Delete any existing ledger so we start fresh
        if (fs.existsSync(DEFAULT_LEDGER_PATH)) fs.unlinkSync(DEFAULT_LEDGER_PATH);

        try {
          const result = await withMockedLLM(
            { label: 'follow-up-question', corrected_text: null, corrected_sources: [] },
            () => judgeFollowUp('q', sources, [{ user: 'u1', text: 'follow-up reply' }])
          );

          assert.equal(result.label, 'follow-up-question');

          // Verify ledger was updated
          assert.ok(fs.existsSync(DEFAULT_LEDGER_PATH), 'Ledger file should exist after follow-up');
          const ledger = JSON.parse(fs.readFileSync(DEFAULT_LEDGER_PATH, 'utf-8'));

          for (const src of sources) {
            assert.ok(src in ledger, `Ledger should have entry for ${src}`);
            assert.equal(ledger[src].followUpCount, 1,
              `followUpCount should be 1 for ${src}, got ${ledger[src].followUpCount}`
            );
            assert.equal(ledger[src].correctionCount, 0,
              `correctionCount should be 0 for ${src}, got ${ledger[src].correctionCount}`
            );
          }
        } finally {
          restoreLedger(backup);
        }
      }
    ), { numRuns: 50 });
  });

  // Feature: usage-staleness-and-correction-loop, Property 7: Correction Label Increments Both Counts on Correct Target Set
  // Validates: Requirements 2.6
  test('Property 7: Correction Label Increments Both Counts (non-empty correctedSources)', async () => {
    await fc.assert(fc.asyncProperty(
      // sources: the original sources cited by the bot
      fc.array(
        fc.string({ minLength: 1, maxLength: 20 }).map(s => (s.replace(/[^a-z0-9]/gi, 'x') || 'src') + '.md'),
        { minLength: 1, maxLength: 4 }
      ).map(arr => [...new Set(arr)]).filter(arr => arr.length > 0),
      // correctedSources: a non-empty subset of different docs (disjoint for clarity)
      fc.array(
        fc.string({ minLength: 1, maxLength: 20 }).map(s => (s.replace(/[^a-z0-9]/gi, 'x') || 'cor') + '-corrected.md'),
        { minLength: 1, maxLength: 3 }
      ).map(arr => [...new Set(arr)]).filter(arr => arr.length > 0),
      async (sources, correctedSources) => {
        // Make sure correctedSources are disjoint from sources for clean verification
        const disjointCorrected = correctedSources.filter(s => !sources.includes(s));
        if (disjointCorrected.length === 0) return; // skip if no disjoint corrected sources

        const backup = backupLedger();
        if (fs.existsSync(DEFAULT_LEDGER_PATH)) fs.unlinkSync(DEFAULT_LEDGER_PATH);

        try {
          const result = await withMockedLLM(
            { label: 'correction', corrected_text: 'the correction', corrected_sources: disjointCorrected },
            () => judgeFollowUp('q', sources, [{ user: 'u1', text: 'actually that is wrong' }])
          );

          assert.equal(result.label, 'correction');

          const ledger = JSON.parse(fs.readFileSync(DEFAULT_LEDGER_PATH, 'utf-8'));

          // correctedSources must have both counts incremented
          for (const src of disjointCorrected) {
            assert.ok(src in ledger, `Ledger should have entry for corrected source ${src}`);
            assert.equal(ledger[src].correctionCount, 1,
              `correctionCount should be 1 for corrected source ${src}`
            );
            assert.equal(ledger[src].followUpCount, 1,
              `followUpCount should be 1 for corrected source ${src}`
            );
          }

          // sources-only entries should NOT be in ledger (they weren't written to)
          for (const src of sources) {
            if (!disjointCorrected.includes(src)) {
              assert.ok(
                !(src in ledger),
                `Sources-only entry ${src} should not be in ledger when correctedSources is non-empty`
              );
            }
          }
        } finally {
          restoreLedger(backup);
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
        const backup = backupLedger();
        if (fs.existsSync(DEFAULT_LEDGER_PATH)) fs.unlinkSync(DEFAULT_LEDGER_PATH);

        try {
          const result = await withMockedLLM(
            { label: 'correction', corrected_text: 'fallback correction', corrected_sources: [] },
            () => judgeFollowUp('q', sources, [{ user: 'u1', text: 'actually wrong' }])
          );

          assert.equal(result.label, 'correction');
          assert.deepEqual(result.correctedSources, []);

          const ledger = JSON.parse(fs.readFileSync(DEFAULT_LEDGER_PATH, 'utf-8'));

          // When correctedSources is empty, falls back to sources
          for (const src of sources) {
            assert.ok(src in ledger, `Ledger should have entry for source ${src} (fallback)`);
            assert.equal(ledger[src].correctionCount, 1,
              `correctionCount should be 1 for source ${src} (fallback)`
            );
            assert.equal(ledger[src].followUpCount, 1,
              `followUpCount should be 1 for source ${src} (fallback)`
            );
          }
        } finally {
          restoreLedger(backup);
        }
      }
    ), { numRuns: 50 });
  });

});
