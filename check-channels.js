import 'dotenv/config';
import { WebClient } from '@slack/web-api';

const client = new WebClient(process.env.SLACK_BOT_TOKEN);

async function checkBotChannels() {
  try {
    // Get bot info
    const authResult = await client.auth.test();
    console.log('Bot Info:');
    console.log('  User ID:', authResult.user_id);
    console.log('  Bot ID:', authResult.bot_id);
    console.log('  Team:', authResult.team);
    console.log('  URL:', authResult.url);

    // List conversations the bot has access to
    console.log('\nFetching channels...');
    try {
      const result = await client.conversations.list({
        team_id: authResult.team_id,
      });
      console.log(`\nFound ${result.channels.length} channels:`);
      
      for (const conv of result.channels) {
        const isMember = conv.is_member;
        const name = conv.name || conv.id;
        console.log(`  [${isMember ? '✓' : ' '}] ${name.padEnd(30)} (${conv.id})`);
      }
    } catch (err) {
      console.log('Error:', err.message);
      console.log('Data:', err.data);
    }

    console.log('\n⚠️  If the bot is not a member of the channel where you are @mentioning it,');
    console.log('   you need to invite it with: /invite @my-rag-bot');

  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

checkBotChannels();
