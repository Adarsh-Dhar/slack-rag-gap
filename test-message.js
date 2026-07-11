import 'dotenv/config';
import { WebClient } from '@slack/web-api';

const client = new WebClient(process.env.SLACK_BOT_TOKEN);

async function testMessage() {
  const channelId = process.argv[2];
  
  if (!channelId) {
    console.log('Usage: node test-message.js <channel_id>');
    console.log('Example: node test-message.js C1234567890');
    process.exit(1);
  }

  try {
    console.log(`Attempting to post to channel ${channelId}...`);
    const result = await client.chat.postMessage({
      channel: channelId,
      text: 'Test message from my-rag-bot - if you see this, the bot can post to this channel!',
    });
    console.log('✓ Message posted successfully!');
    console.log('  Timestamp:', result.ts);
    console.log('  Channel:', result.channel);
  } catch (error) {
    console.error('✗ Error posting message:');
    console.error('  Message:', error.message);
    console.error('  Data:', error.data);
  }
}

testMessage();
