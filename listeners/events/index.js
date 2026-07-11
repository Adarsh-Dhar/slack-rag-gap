import { appMentionCallback } from './app_mention.js';
import { threadReplyCallback } from './thread_reply.js';
import { getLastAnswerForThread } from '../../agent/rag.js';
import log from '../../agent/logger.js';

/**
 * @param {import("@slack/bolt").App} app
 */
export const register = (app) => {
  // Diagnostic: log all events to verify Slack is delivering anything
  app.use(async ({ next, logger, event }) => {
    logger.info(`Event received: ${event.type}`, { eventType: event.type });
    await next();
  });

  app.event('app_mention', appMentionCallback);

  // Listen for threaded replies so we can detect corrections and follow-ups
  // on threads where the bot previously answered a question.
  app.event('message', async ({ event, client, logger }) => {
    logger.info(
      `message event: subtype=${event.subtype ?? 'none'} bot_id=${event.bot_id ?? 'none'} thread_ts=${event.thread_ts ?? 'none'} channel_type=${event.channel_type ?? 'none'}`,
    );
    // Only handle new threaded replies — skip bot messages, message_changed,
    // and other non-user subtypes to avoid re-processing edits or duplicates.
    if (!event.thread_ts || event.subtype === 'bot_message' || event.subtype === 'message_changed' || event.bot_id)
      return;
    await threadReplyCallback({ event, client, logger });
  });

  // Diagnostic: log assistant_thread events to confirm they're being delivered.
  // If these don't appear in logs when you open the Assistant panel, Slack isn't
  // delivering events — restart `slack run` and check the bot is installed correctly.
  app.event('assistant_thread_started', async ({ logger }) => {
    logger.info('assistant_thread_started event received — Slack event delivery is working');
  });
};
