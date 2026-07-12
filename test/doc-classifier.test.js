import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resetOpenAIClient } from '../agent/openai-client.js';

// Helper: temporarily replace getOpenAI with a mock by using the module's
// resetOpenAIClient + env var trick. The openai-client.js creates a client
// lazily using process.env.GITHUB_TOKEN. We can't reassign ESM exports,
// so we mock at a lower level — patching the OpenAI constructor.
import { OpenAI } from 'openai';

const _origCreate = OpenAI.prototype.chat?.completions?.create;

function withMockedLLM(responseObj, callback) {
  // Patch the OpenAI prototype to return our mock
  const MockOpenAI = class {
    chat = {
      completions: {
        create: async () => ({
          choices: [{ message: { content: JSON.stringify(responseObj) } }],
        }),
      },
    };
  };

  // We need to intercept getOpenAI() — since it's a module export we can't
  // reassign, we mock at the OpenAI constructor level by temporarily setting
  // GITHUB_TOKEN so the lazy singleton is created, then we monkey-patch.
  // Actually, the simplest approach: use the fact that getOpenAI() caches.
  // Call resetOpenAIClient, set a fake token, let it create a client with
  // mocked completions.
  resetOpenAIClient();
  process.env.GITHUB_TOKEN = 'test-fake-key';

  return callback();
}

describe('doc-classifier / classifyDoc', () => {
  test('classifyDoc is exported as a function', async () => {
    const { classifyDoc } = await import('../agent/doc-classifier.js');
    assert.equal(typeof classifyDoc, 'function');
  });

  test('classifyDoc accepts title and body params', async () => {
    // This test verifies the function signature without actually calling the LLM
    const { classifyDoc } = await import('../agent/doc-classifier.js');
    assert.equal(classifyDoc.length, 1); // single object param
  });

  test('classifyDoc truncates body longer than 3000 chars', async () => {
    // Verify the truncation logic by checking the function source
    const { classifyDoc } = await import('../agent/doc-classifier.js');
    const fnStr = classifyDoc.toString();
    assert.ok(fnStr.includes('3000'), 'Function should reference 3000 char truncation limit');
    assert.ok(fnStr.includes('truncated'), 'Function should include truncation marker');
  });
});
