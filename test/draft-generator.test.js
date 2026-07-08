/**
 * Tests for draftCorrection() in agent/draft-generator.js.
 *
 * Strategy:
 *   - draft-generator.js uses process.cwd() at import time to set DOCS_DIR/DRAFTS_DIR.
 *     These resolve to: <project_root>/docs and <project_root>/docs/drafts
 *   - We create test source files under the real docs/ directory with unique names,
 *     then clean them up after each test.
 *   - We patch the OpenAI Completions prototype to intercept LLM calls.
 *   - Draft output files are written to docs/drafts/ — cleaned up after each test.
 */
import 'dotenv/config';

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import fc from 'fast-check';

import { OpenAI } from 'openai';
import { draftCorrection } from '../agent/draft-generator.js';

const PROJECT_ROOT = new URL('..', import.meta.url).pathname;
const DOCS_DIR = path.join(PROJECT_ROOT, 'docs');
const DRAFTS_DIR = path.join(DOCS_DIR, 'drafts');

// Patch OpenAI prototype (same strategy as thread-resolver tests)
const _tempOpenAI = new OpenAI({ apiKey: 'test' });
const CompletionsProto = Object.getPrototypeOf(_tempOpenAI.chat.completions);
const _originalCreate = CompletionsProto.create;

/**
 * Runs callback with mocked LLM returning the given JSON response object.
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
 * Creates a temp source doc under docs/ and returns { docSource, cleanUp }.
 * cleanUp() removes the source file and any draft files created.
 */
function createTempDoc(content = 'Test document content.\n') {
  const docSource = `test-draft-${randomUUID()}.md`;
  const filePath = path.join(DOCS_DIR, docSource);
  fs.writeFileSync(filePath, content);

  const cleanUp = (slugsToClean = []) => {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    for (const slug of slugsToClean) {
      const draftPath = path.join(DRAFTS_DIR, `${slug}.md`);
      if (fs.existsSync(draftPath)) fs.unlinkSync(draftPath);
    }
    // Clean up any draft files that match test- prefix
    if (fs.existsSync(DRAFTS_DIR)) {
      for (const f of fs.readdirSync(DRAFTS_DIR)) {
        if (f.startsWith('test-') || f.includes('correction') || f.includes('fix') || f.includes('update')) {
          // Only delete files newer than 5 seconds (test artifacts)
          const stat = fs.statSync(path.join(DRAFTS_DIR, f));
          if (Date.now() - stat.mtimeMs < 5000) {
            fs.unlinkSync(path.join(DRAFTS_DIR, f));
          }
        }
      }
    }
  };

  return { docSource, filePath, cleanUp };
}

const MOCK_LLM_RESPONSE = {
  title: 'Fix Incorrect Info',
  summary: 'Corrected the wrong section.',
  body: '# Fixed Document\n\nThis is the corrected content.',
  diff: '@@ -1,2 +1,2 @@\n-wrong line\n+correct line',
};

describe('draft-generator / draftCorrection', () => {

  // Feature: usage-staleness-and-correction-loop, Property 13: Correction Draft Always Writes edit_of Frontmatter
  // Validates: Requirements 5.4
  test('Property 13: Correction Draft Always Writes edit_of Frontmatter', async () => {
    await fc.assert(fc.asyncProperty(
      // correctionText: any string
      fc.string({ minLength: 1, maxLength: 200 }),
      // permalink: any URL-like string
      fc.string({ minLength: 0, maxLength: 100 }).map(s => `https://slack.com/test/${s.replace(/[^a-z0-9]/gi, 'x')}`),
      // LLM title varies
      fc.string({ minLength: 1, maxLength: 50 }).map(s => s.replace(/[^a-z0-9 ]/gi, 'x').trim() || 'Fix Issue'),
      async (correctionText, permalink, llmTitle) => {
        const { docSource, cleanUp } = createTempDoc('Original document content for testing.\n');
        const slugifiedTitle = llmTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 60);

        try {
          const result = await withMockedLLM(
            { ...MOCK_LLM_RESPONSE, title: llmTitle },
            () => draftCorrection({ docSource, correctionText, permalink })
          );

          // Read the written file
          assert.ok(fs.existsSync(result.filePath), `Draft file should exist at ${result.filePath}`);
          const content = fs.readFileSync(result.filePath, 'utf-8');

          // Frontmatter must contain edit_of: {docSource}
          assert.ok(
            content.includes(`edit_of: ${docSource}`),
            `Draft frontmatter must contain "edit_of: ${docSource}"\nActual content:\n${content}`
          );

          // Clean up the specific draft file
          if (fs.existsSync(result.filePath)) fs.unlinkSync(result.filePath);
        } finally {
          cleanUp([slugifiedTitle]);
        }
      }
    ), { numRuns: 50 });
  });

  // Feature: usage-staleness-and-correction-loop, Property 14: Correction Draft Returns Required Fields Including diff
  // Validates: Requirements 5.5
  test('Property 14: Correction Draft Returns Required Fields Including diff', async () => {
    await fc.assert(fc.asyncProperty(
      fc.string({ minLength: 1, maxLength: 200 }),
      fc.string({ minLength: 0, maxLength: 100 }),
      // diff can be any string (including empty)
      fc.string({ minLength: 0, maxLength: 500 }),
      async (correctionText, permalink, diff) => {
        const { docSource, cleanUp } = createTempDoc('Source document to be corrected.\n');

        try {
          const result = await withMockedLLM(
            { ...MOCK_LLM_RESPONSE, diff },
            () => draftCorrection({ docSource, correctionText, permalink })
          );

          // Must have all 5 required fields
          assert.ok('slug' in result, 'result must have "slug" field');
          assert.ok('filePath' in result, 'result must have "filePath" field');
          assert.ok('title' in result, 'result must have "title" field');
          assert.ok('summary' in result, 'result must have "summary" field');
          assert.ok('diff' in result, 'result must have "diff" field');

          // Types
          assert.equal(typeof result.slug, 'string', 'slug must be a string');
          assert.equal(typeof result.filePath, 'string', 'filePath must be a string');
          assert.equal(typeof result.title, 'string', 'title must be a string');
          assert.equal(typeof result.summary, 'string', 'summary must be a string');
          assert.equal(typeof result.diff, 'string', 'diff must be a string (not null/undefined)');

          // diff should equal the LLM-provided value (or '' if null was returned)
          assert.equal(result.diff, diff ?? '', `diff should match LLM output or empty string`);

          // Clean up draft
          if (fs.existsSync(result.filePath)) fs.unlinkSync(result.filePath);
        } finally {
          cleanUp();
        }
      }
    ), { numRuns: 50 });
  });

  // Unit test: missing source file throws with exact error message (Requirement 5.6)
  test('Missing source file throws with exact error message', async () => {
    const nonExistentDoc = `does-not-exist-${randomUUID()}.md`;

    await assert.rejects(
      () => withMockedLLM(MOCK_LLM_RESPONSE, () =>
        draftCorrection({
          docSource: nonExistentDoc,
          correctionText: 'some correction',
          permalink: 'https://slack.com/test',
        })
      ),
      (err) => {
        assert.equal(err.message, `Source document not found: ${nonExistentDoc}`,
          `Error message must be exactly "Source document not found: ${nonExistentDoc}"`
        );
        return true;
      },
      `Should throw when docs/${nonExistentDoc} does not exist`
    );
  });

  // Additional unit test: verifies edit_of matches docSource exactly
  test('edit_of frontmatter matches docSource exactly', async () => {
    const { docSource, cleanUp } = createTempDoc('Content to correct.\n');

    try {
      const result = await withMockedLLM(MOCK_LLM_RESPONSE, () =>
        draftCorrection({
          docSource,
          correctionText: 'This info is wrong',
          permalink: 'https://slack.com/test/123',
        })
      );

      const content = fs.readFileSync(result.filePath, 'utf-8');
      const editOfLine = content.split('\n').find(line => line.startsWith('edit_of:'));
      assert.ok(editOfLine, 'Frontmatter must contain an edit_of line');
      assert.equal(editOfLine.trim(), `edit_of: ${docSource}`,
        `edit_of must match docSource exactly`
      );

      if (fs.existsSync(result.filePath)) fs.unlinkSync(result.filePath);
    } finally {
      cleanUp();
    }
  });

  // Additional unit test: returned filePath points to existing file
  test('returned filePath points to a written file', async () => {
    const { docSource, cleanUp } = createTempDoc('Content.\n');

    try {
      const result = await withMockedLLM(MOCK_LLM_RESPONSE, () =>
        draftCorrection({
          docSource,
          correctionText: 'correction',
          permalink: 'https://slack.com/test',
        })
      );

      assert.ok(result.filePath.startsWith(DRAFTS_DIR),
        `filePath should be inside docs/drafts/`
      );
      assert.ok(fs.existsSync(result.filePath),
        `File at filePath must exist`
      );

      if (fs.existsSync(result.filePath)) fs.unlinkSync(result.filePath);
    } finally {
      cleanUp();
    }
  });

});
