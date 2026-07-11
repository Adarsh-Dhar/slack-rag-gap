import 'dotenv/config';
import { WebClient } from '@slack/web-api';

const client = new WebClient(process.env.SLACK_BOT_TOKEN);

async function checkEventSubscriptions() {
  try {
    console.log('Checking app configuration...');
    
    // Get app info
    const authResult = await client.auth.test();
    console.log('App Info:');
    console.log('  App ID:', process.env.APP_ID);
    console.log('  Team ID:', authResult.team_id);
    console.log('  Bot ID:', authResult.bot_id);
    
    // Try to get the app's event subscriptions
    // Note: This requires admin level access, so we'll check what we can
    console.log('\nChecking bot scopes...');
    const botInfo = await client.auth.test();
    console.log('  Bot has these scopes:', authResult.response_metadata?.scopes || 'Not available in auth.test');
    
    // Check if we can access the app's configuration
    try {
      const appsInfo = await client.apps.info({
        app_id: process.env.APP_ID,
      });
      console.log('\nApp configuration:');
      console.log(JSON.stringify(appsInfo, null, 2));
    } catch (err) {
      console.log('\nCannot access apps.info (requires admin):', err.message);
    }
    
  } catch (error) {
    console.error('Error:', error.message);
    console.error('Data:', error.data);
  }
}

checkEventSubscriptions();
