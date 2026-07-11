import 'dotenv/config';
import { WebClient } from '@slack/web-api';

const client = new WebClient(process.env.SLACK_BOT_TOKEN);

async function joinChannel(channelId) {
  try {
    console.log(`Attempting to join channel ${channelId}...`);
    
    const result = await client.conversations.join({
      channel: channelId,
    });
    
    console.log('✓ Successfully joined channel!');
    console.log('  Channel name:', result.channel.name);
    console.log('  Channel ID:', result.channel.id);
    console.log('  Is member:', result.channel.is_member);
  } catch (error) {
    console.error('✗ Error joining channel:');
    console.error('  Message:', error.message);
    console.error('  Data:', error.data);
  }
}

joinChannel('C0BGJ1KFRNU');
