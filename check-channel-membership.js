import 'dotenv/config';
import { WebClient } from '@slack/web-api';

const client = new WebClient(process.env.SLACK_BOT_TOKEN);

async function checkMembership(channelId) {
  try {
    console.log(`Checking if bot is member of channel ${channelId}...`);
    
    const result = await client.conversations.info({
      channel: channelId,
    });
    
    console.log('Channel info:');
    console.log('  Name:', result.channel.name);
    console.log('  Is member:', result.channel.is_member);
    console.log('  Is private:', result.channel.is_private);
    console.log('  Is archived:', result.channel.is_archived);
    
    if (!result.channel.is_member) {
      console.log('\n❌ Bot is NOT a member of this channel!');
      console.log('   You need to invite the bot with: /invite @my-rag-bot');
    } else {
      console.log('\n✓ Bot IS a member of this channel');
    }
  } catch (error) {
    console.error('Error:', error.message);
    console.error('Data:', error.data);
  }
}

checkMembership('C0BGJ1KFRNU');
