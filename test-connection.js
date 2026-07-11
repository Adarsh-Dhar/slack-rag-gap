import 'dotenv/config';
import { App, LogLevel } from '@slack/bolt';

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
  logLevel: LogLevel.DEBUG,
});

// Log ALL events
app.use(async ({ next, logger, event, payload }) => {
  const eventType = event?.type || payload?.type || 'unknown';
  logger.info(`🔔 EVENT RECEIVED: ${eventType}`, { eventType, event, payload });
  await next();
});

app.event('app_mention', async ({ event, logger }) => {
  logger.info('🎯 APP_MENTION RECEIVED!', { event });
});

app.message(async ({ event, logger }) => {
  logger.info('💬 MESSAGE RECEIVED!', { event });
});

(async () => {
  await app.start();
  console.log('⚡ Bot started - waiting for events...');
  console.log('Try sending a DM to @my-rag-bot or mentioning it in a channel');
})();
