import { feedbackActionCallback } from './feedback.js';
import { draftApprovalCallback } from './draft_approval.js';

/**
 * @param {import("@slack/bolt").App} app
 */
export const register = (app) => {
  app.action('feedback', feedbackActionCallback);
  app.action('draft_approve', draftApprovalCallback);
  app.action('draft_reject', draftApprovalCallback);
};
