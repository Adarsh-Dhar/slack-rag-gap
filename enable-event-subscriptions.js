import 'dotenv/config';
import { WebClient } from '@slack/web-api';

const client = new WebClient(process.env.SLACK_BOT_TOKEN);

async function enableEventSubscriptions() {
  try {
    console.log('Attempting to enable event subscriptions...');
    
    // Try to update the app's event subscriptions
    // Note: This requires the app to be configured with a request URL in HTTP mode
    // In Socket Mode, events are delivered via WebSocket, so we need to ensure
    // the app is properly configured for Socket Mode
    
    // First, let's check the current app configuration
    const authResult = await client.auth.test();
    console.log('Current app configuration:');
    console.log('  Team:', authResult.team);
    console.log('  User:', authResult.user);
    console.log('  Bot ID:', authResult.bot_id);
    
    // In Socket Mode, we need to ensure the app is properly installed
    // and the manifest has the correct event subscriptions
    
    console.log('\nChecking if app is properly configured for Socket Mode...');
    console.log('  Socket Mode should be enabled in manifest');
    console.log('  Event subscriptions should be configured in manifest');
    console.log('  App should be re-installed after manifest changes');
    
    console.log('\nTo fix this issue:');
    console.log('1. Go to https://api.slack.com/apps');
    console.log('2. Select your app (my-rag-bot)');
    console.log('3. Go to "Event Subscriptions"');
    console.log('4. Enable "Subscribe to bot events"');
    console.log('5. Add these events:');
    console.log('   - app_mention');
    console.log('   - message.channels');
    console.log('   - message.groups');
    console.log('   - message.im');
    console.log('6. Save changes and re-install the app');
    
  } catch (error) {
    console.error('Error:', error.message);
    console.error('Data:', error.data);
  }
}

enableEventSubscriptions();
