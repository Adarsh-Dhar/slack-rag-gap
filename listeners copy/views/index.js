import { draftEditSubmitCallback } from './draft_edit_submit.js';

/**
 * @param {import("@slack/bolt").App} app
 */
export const register = (app) => {
  app.view('draft_edit_modal', draftEditSubmitCallback);
};
