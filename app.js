import 'dotenv/config';
import { App, LogLevel } from '@slack/bolt';
import { registerListeners } from './listeners/index.js';

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
  logLevel: LogLevel.INFO,
});

registerListeners(app);

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});

(async () => {
  try {
    await app.start();
    console.log('⚡️ Bolt app started');
  } catch (error) {
    console.error('Failed to start app:', error);
    process.exit(1);
  }
})();
