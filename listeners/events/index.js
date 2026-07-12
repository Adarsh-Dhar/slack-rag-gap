import { appMentionCallback } from './app_mention.js';
import { threadReplyCallback } from './thread_reply.js';

/**
 * @param {import("@slack/bolt").App} app
 */
export const register = (app) => {
  app.event('app_mention', appMentionCallback);

  app.message(async ({ message, client, logger }) => {
    if (message.subtype || message.bot_id) return;
    await threadReplyCallback({ event: message, client, logger });
  });
};
