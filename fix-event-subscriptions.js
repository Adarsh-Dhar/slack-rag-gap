import 'dotenv/config';
import { WebClient } from '@slack/web-api';

const client = new WebClient(process.env.SLACK_BOT_TOKEN);

async function fixEventSubscriptions() {
  try {
    console.log('Attempting to fix event subscriptions...');

    // The issue is that event subscriptions are not enabled in the app
    // even though they're in the manifest. We need to ensure the app
    // is properly configured for Socket Mode with event subscriptions.

    // Let's try to use the admin API to update the app configuration
    // Note: This requires admin permissions

    console.log('Current configuration check:');
    const authResult = await client.auth.test();
    console.log('  App ID:', process.env.APP_ID);
    console.log('  Team ID:', authResult.team_id);
    console.log('  Bot ID:', authResult.bot_id);

    // Try to check if we can use the admin API
    try {
      // This will fail if we don't have admin permissions
      const result = await client.admin.apps.approve({
        app_id: process.env.APP_ID,
        team_id: authResult.team_id,
      });
      console.log('Admin API result:', result);
    } catch (err) {
      console.log('Admin API not available:', err.message);
    }

    // Alternative: Try to use the apps API to update configuration
    console.log('\nTrying alternative approach...');

    // Since we can't directly enable event subscriptions via API without admin access,
    // let's try to verify the current state and provide guidance

    console.log('\n=== DIAGNOSIS ===');
    console.log('The bot can POST to Slack but cannot RECEIVE events.');
    console.log('This means event subscriptions are not enabled in the Slack app.');
    console.log('\n=== SOLUTION ===');
    console.log('You need to manually enable event subscriptions:');
    console.log('1. Go to: https://api.slack.com/apps/A0BG7B1S54P');
    console.log('2. Click on "Event Subscriptions" in the left sidebar');
    console.log('3. Turn ON "Subscribe to bot events"');
    console.log('4. Add these events:');
    console.log('   - app_mention');
    console.log('   - message.channels');
    console.log('   - message.groups');
    console.log('   - message.im');
    console.log('5. Click "Save Changes"');
    console.log('6. Re-install the app to your workspace');
  } catch (error) {
    console.error('Error:', error.message);
    console.error('Data:', error.data);
  }
}

fixEventSubscriptions();
