import * as actions from './actions/index.js';
import * as assistant from './assistant/index.js';
import * as events from './events/index.js';
import * as views from './views/index.js';
import log from '../agent/logger.js';

/**
 * @param {import("@slack/bolt").App} app
 */
export const registerListeners = (app) => {
  // Absolute earliest hook available to our code: this fires for every
  // payload Bolt's receiver hands off — events, actions, commands, view
  // submissions, shortcuts — before it's routed to any type-specific
  // listener below. Use this to confirm Slack is reaching the app at all,
  // before debugging further downstream (e.g. in a specific event handler).
  app.use(async ({ next, body }) => {
    console.log('=== RAW PAYLOAD RECEIVED ===');
    console.log('Body type:', body?.type);
    console.log('Event type:', body?.event?.type);
    console.log('Team ID:', body?.team_id);
    console.log('Full body:', JSON.stringify(body, null, 2));
    console.log('=== END RAW PAYLOAD ===');
    
    log.info(
      {
        module: 'listeners',
        event: 'app_contacted',
        bodyType: body?.type,
        innerEventType: body?.event?.type,
        team: body?.team_id,
      },
      'Slack payload received by app',
    );
    await next();
  });

  actions.register(app);
  events.register(app);
  assistant.register(app);
  views.register(app);
};
