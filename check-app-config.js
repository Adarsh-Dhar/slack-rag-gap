import 'dotenv/config';
import { WebClient } from '@slack/web-api';

const client = new WebClient(process.env.SLACK_BOT_TOKEN);

async function checkAppConfig() {
  try {
    console.log('Checking app configuration...');
    
    const authResult = await client.auth.test();
    console.log('App Info:');
    console.log('  App ID:', process.env.APP_ID);
    console.log('  Team ID:', authResult.team_id);
    console.log('  Bot ID:', authResult.bot_id);
    
    // Try to get the app's configuration using the admin API
    // This requires admin permissions, so it will likely fail
    try {
      const result = await client.admin.apps.config.get({
        app_id: process.env.APP_ID,
      });
      console.log('\nApp configuration:');
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      console.log('\nCannot access admin.apps.config (requires admin):', err.message);
    }
    
    // Try to check if event subscriptions are enabled by testing a simple API call
    // that would fail if the app is not properly configured
    console.log('\nTesting if event subscriptions are active...');
    console.log('If event subscriptions were active, we would see events in the logs.');
    console.log('Since we see no events, event subscriptions are likely NOT enabled.');
    
    console.log('\n=== SOLUTION ===');
    console.log('You need to manually enable event subscriptions in the Slack app:');
    console.log('1. Go to: https://api.slack.com/apps/A0BG7B1S54P/event-subscriptions');
    console.log('2. Turn ON "Subscribe to bot events"');
    console.log('3. Add these events:');
    console.log('   - app_mention');
    console.log('   - message.channels');
    console.log('   - message.groups');
    console.log('   - message.im');
    console.log('4. Click "Save Changes"');
    console.log('5. Re-install the app to your workspace');
    
  } catch (error) {
    console.error('Error:', error.message);
    console.error('Data:', error.data);
  }
}

checkAppConfig();
