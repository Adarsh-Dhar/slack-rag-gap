import 'dotenv/config';
import { WebClient } from '@slack/web-api';

const client = new WebClient(process.env.SLACK_BOT_TOKEN);

async function checkBotInfo() {
  try {
    const authResult = await client.auth.test();
    console.log('Bot Auth Info:', JSON.stringify(authResult, null, 2));
    
    const botInfo = await client.bots.info({ bot: authResult.bot_id });
    console.log('Bot Info:', JSON.stringify(botInfo, null, 2));
  } catch (error) {
    console.error('Error:', error.message);
  }
}

checkBotInfo();
