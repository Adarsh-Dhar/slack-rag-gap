import { callLLM } from '../../agent/llm-caller.js';
import { feedbackBlock } from '../views/feedback_block.js';

/**
 * Parses a doc-owner command from text.
 * Supports: "assign owner of <doc> to @user", "who owns <doc>", "list owners"
 *
 * @param {string} text
 * @returns {{type: 'assign'|'who'|'list', docName?: string, newOwnerId?: string}|null}
 */
export function parseOwnerCommand(text) {
  const lowerText = text.toLowerCase().trim();

  // "assign owner of <doc> to @user"
  const assignMatch = lowerText.match(/assign\s+owner\s+of\s+(\S+)\s+to\s+<@(\w+)>/);
  if (assignMatch) {
    return { type: 'assign', docName: assignMatch[1], newOwnerId: assignMatch[2] };
  }

  // "who owns <doc>"
  const whoMatch = lowerText.match(/who\s+owns\s+(\S+)/);
  if (whoMatch) {
    return { type: 'who', docName: whoMatch[1] };
  }

  // "list owners"
  if (lowerText.includes('list') && lowerText.includes('owner')) {
    return { type: 'list' };
  }

  return null;
}

/**
 * Parses a process-owner command from text.
 * Supports: "assign process owner of <topic> to @user", "who owns process <topic>", "list process owners"
 *
 * @param {string} text
 * @returns {{type: 'assign'|'who'|'list', topicName?: string, newOwnerId?: string, keywords?: string[]}|null}
 */
export function parseProcessOwnerCommand(text) {
  const lowerText = text.toLowerCase().trim();

  // "assign process owner of <topic> to @user"
  const assignMatch = lowerText.match(/assign\s+process\s+owner\s+of\s+(\S+)\s+to\s+<@(\w+)>/);
  if (assignMatch) {
    return { type: 'assign', topicName: assignMatch[1], newOwnerId: assignMatch[2] };
  }

  // "who owns process <topic>"
  const whoMatch = lowerText.match(/who\s+owns\s+process\s+(\S+)/);
  if (whoMatch) {
    return { type: 'who', topicName: whoMatch[1] };
  }

  // "list process owners"
  if (lowerText.includes('list') && lowerText.includes('process') && lowerText.includes('owner')) {
    return { type: 'list' };
  }

  return null;
}

/**
 * Handles the event when the app is mentioned in a Slack conversation
 * and generates an AI response.
 *
 * @param {Object} params
 * @param {import("@slack/types").AppMentionEvent} params.event - The app mention event.
 * @param {import("@slack/web-api").WebClient} params.client - Slack web client.
 * @param {import("@slack/logger").Logger} params.logger - Logger instance.
 * @param {import("@slack/bolt").SayFn} params.say - Function to send messages.
 *
 * @see {@link https://docs.slack.dev/reference/events/app_mention/}
 */
export const appMentionCallback = async ({ event, client, logger, say }) => {
  try {
    const { channel, text, team, user } = event;
    const thread_ts = event.thread_ts || event.ts;

    await client.assistant.threads.setStatus({
      channel_id: channel,
      thread_ts: thread_ts,
      status: 'thinking...',
      loading_messages: [
        'Teaching the hamsters to type faster…',
        'Untangling the internet cables…',
        'Consulting the office goldfish…',
        'Polishing up the response just for you…',
        'Convincing the AI to stop overthinking…',
      ],
    });

    const streamer = client.chatStream({
      channel: channel,
      recipient_team_id: team,
      recipient_user_id: user,
      thread_ts: thread_ts,
    });

    const prompts = [
      {
        role: 'user',
        content: text,
      },
    ];

    await callLLM(streamer, prompts, { channel, thread_ts, source: 'app_mention' });

    await streamer.stop({ blocks: [feedbackBlock] });
  } catch (e) {
    logger.error(`Failed to handle a user message event: ${e}`);
    await say(`:warning: Something went wrong! (${e})`);
  }
};
