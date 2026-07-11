import 'dotenv/config';
import { WebClient } from '@slack/web-api';

const client = new WebClient(process.env.SLACK_BOT_TOKEN);

async function testPostMessage() {
  try {
    const channelId = process.env.TEST_CHANNEL_ID || 'C0BF8AEMVL7';
    
    console.log(`\nTrying to post a message to channel: ${channelId}`);
    
    const result = await client.chat.postMessage({
      channel: channelId,
      text: '🧪 Test message from bot - if you see this, the bot CAN post to the channel',
    });
    
    console.log('✅ Message posted successfully!');
    console.log('Message timestamp:', result.ts);
    console.log('\nThis confirms the bot IS in the channel and CAN post.');
    console.log('The issue is that Slack is NOT delivering events via Socket Mode.');
    console.log('\nThis is likely an Enterprise Grid policy or configuration issue.');
    console.log('Options:');
    console.log('1. Contact Slack admin to enable Socket Mode for Enterprise Grid');
    console.log('2. Switch to HTTP mode (requires public endpoint like ngrok)');
    
  } catch (error) {
    console.error('❌ Error posting message:', error.message);
    if (error.data) {
      console.error('Error data:', error.data);
    }
  }
}

testPostMessage();
