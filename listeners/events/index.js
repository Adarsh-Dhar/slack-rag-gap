import { appMentionCallback } from './app_mention.js';
import { threadReplyCallback } from './thread_reply.js';

/**
 * @param {import("@slack/bolt").App} app
 */
export const register = (app) => {
  app.event('app_mention', appMentionCallback);

  // Listen for threaded replies so we can detect corrections and follow-ups
  // on threads where the bot previously answered a question.
  app.event('message', async ({ event, client, logger }) => {
    // Only handle replies in existing threads (not fresh messages or bot messages)
    if (!event.thread_ts || event.subtype === 'bot_message' || event.bot_id) return;
    await threadReplyCallback({ event, client, logger });
  });
};
