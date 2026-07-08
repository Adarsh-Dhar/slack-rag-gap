import { appMentionCallback } from './app_mention.js';

/**
 * @param {import("@slack/bolt").App} app
 */
export const register = (app) => {
  // Test: log ALL events to see if anything is coming through
  app.use(async ({ next, logger, event }) => {
    console.log('[DEBUG] Event received:', event.type);
    await next();
  });

  app.event('app_mention', appMentionCallback);
};
