import { draftApprovalCallback } from './draft_approval.js';
import { draftEditCallback } from './draft_edit.js';

/**
 * @param {import("@slack/bolt").App} app
 */
export const register = (app) => {
  app.action('draft_approve', draftApprovalCallback);
  app.action('draft_reject', draftApprovalCallback);
  app.action('draft_edit', draftEditCallback);
};
