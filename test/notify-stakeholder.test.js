import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { notifyStakeholder } from '../agent/notify-stakeholder.js';

/**
 * Creates a mock Slack client that captures the last postMessage call.
 */
function makeMockClient(dmChannelId = 'D_TEST_CHANNEL') {
  const calls = [];
  const client = {
    conversations: {
      open: async () => ({ channel: { id: dmChannelId } }),
    },
    chat: {
      postMessage: async (payload) => {
        calls.push(payload);
      },
    },
    getCalls: () => calls,
    lastCall: () => calls[calls.length - 1],
  };
  return client;
}

describe('notify-stakeholder', () => {

  // Feature: usage-staleness-and-correction-loop, Property 11: Diff Block Injected Before Actions When diff Is Present
  // Validates: Requirements 4.4
  test('Property 11: Diff Block Injected Before Actions When diff Is Present', async () => {
    await fc.assert(fc.asyncProperty(
      // Any non-empty diff string
      fc.string({ minLength: 1, maxLength: 200 }),
      fc.string({ minLength: 1, maxLength: 60 }).map(s => s.replace(/[^a-z0-9]/gi, 'x') || 'title'),
      fc.string({ minLength: 0, maxLength: 100 }),
      async (diff, title, summary) => {
        const client = makeMockClient();
        const draft = {
          slug: 'test-slug',
          title,
          summary,
          permalink: 'https://slack.com/test',
          diff,
        };

        // Set env var so the call doesn't no-op
        const original = process.env.STAKEHOLDER_USER_ID;
        process.env.STAKEHOLDER_USER_ID = 'U12345TEST';
        try {
          await notifyStakeholder(client, draft, 'U12345TEST', 'test reason');
        } finally {
          process.env.STAKEHOLDER_USER_ID = original;
        }

        const payload = client.lastCall();
        assert.ok(payload, 'postMessage should have been called');
        const blocks = payload.blocks;

        // Must have exactly 4 blocks: section, context, diff section, actions
        assert.equal(blocks.length, 4, `Expected 4 blocks when diff is present, got ${blocks.length}`);

        // The third block (index 2) must be a section with mrkdwn containing the diff in a code fence
        const diffBlock = blocks[2];
        assert.equal(diffBlock.type, 'section', 'Third block must be a section block');
        assert.equal(diffBlock.text.type, 'mrkdwn', 'Diff block text must be mrkdwn');
        assert.ok(
          diffBlock.text.text.includes(diff),
          'Diff block must contain the diff text'
        );
        assert.ok(
          diffBlock.text.text.includes('```'),
          'Diff block must use code fence'
        );

        // The last block must be the actions block
        const actionsBlock = blocks[3];
        assert.equal(actionsBlock.type, 'actions', 'Last block must be the actions block');
        assert.equal(actionsBlock.block_id, 'draft_review');

        // Diff block must be immediately before actions block
        const diffIndex = blocks.findIndex(b => b === diffBlock);
        const actionsIndex = blocks.findIndex(b => b === actionsBlock);
        assert.equal(actionsIndex - diffIndex, 1, 'Diff block must be immediately before actions block');
      }
    ), { numRuns: 100 });
  });

  // Feature: usage-staleness-and-correction-loop, Property 12: Backwards Compatibility — No Diff Block When diff Is Absent
  // Validates: Requirements 4.5
  test('Property 12: Backwards Compatibility — No Diff Block When diff Is Absent', async () => {
    const noDiffVariants = [
      fc.constant(null),
      fc.constant(undefined),
      // draft object with no diff key at all (use record without diff)
    ];

    await fc.assert(fc.asyncProperty(
      // diff is null or missing (alternate between null and absent)
      fc.boolean(),
      fc.string({ minLength: 1, maxLength: 60 }).map(s => s.replace(/[^a-z0-9]/gi, 'x') || 'title'),
      fc.string({ minLength: 0, maxLength: 100 }),
      async (useDiffNull, title, summary) => {
        const client = makeMockClient();
        const draft = {
          slug: 'test-slug',
          title,
          summary,
          permalink: 'https://slack.com/test',
          ...(useDiffNull ? { diff: null } : {}),
          // When useDiffNull is false, diff key is absent entirely
        };

        const original = process.env.STAKEHOLDER_USER_ID;
        process.env.STAKEHOLDER_USER_ID = 'U12345TEST';
        try {
          await notifyStakeholder(client, draft, 'U12345TEST', 'test reason');
        } finally {
          process.env.STAKEHOLDER_USER_ID = original;
        }

        const payload = client.lastCall();
        assert.ok(payload, 'postMessage should have been called');
        const blocks = payload.blocks;

        // Must have exactly 3 blocks: section, context, actions
        assert.equal(blocks.length, 3, `Expected exactly 3 blocks when diff is absent/null, got ${blocks.length}`);

        assert.equal(blocks[0].type, 'section', 'First block must be section');
        assert.equal(blocks[1].type, 'context', 'Second block must be context');
        assert.equal(blocks[2].type, 'actions', 'Third block must be actions');
        assert.equal(blocks[2].block_id, 'draft_review');
      }
    ), { numRuns: 100 });
  });

});
