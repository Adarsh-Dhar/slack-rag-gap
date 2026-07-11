import { appMentionCallback } from './app_mention.js';
import { threadReplyCallback } from './thread_reply.js';

/**
 * @param {import("@slack/bolt").App} app
 */
export const register = (app) => {
  app.event('app_mention', appMentionCallback);

  app.event('message', async ({ event, client, logger }) => {
    if (!event.thread_ts || event.subtype === 'bot_message' || event.subtype === 'message_changed' || event.bot_id)
      return;
    await threadReplyCallback({ event, client, logger });
  });

  app.event('assistant_thread_started', async ({ logger }) => {
    logger.debug('assistant_thread_started event received');
  });
};
