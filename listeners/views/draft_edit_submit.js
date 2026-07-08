import fs from 'fs';
import path from 'path';

const DRAFTS_DIR = path.join(process.cwd(), 'docs', 'drafts');

/**
 * Handles submission of the "Edit draft" modal opened by
 * listeners/actions/draft_edit.js. Rewrites the draft file in place with
 * the edited title/body — the draft stays in docs/drafts/ with
 * status: pending_review, so Approve/Reject on the (refreshed) review
 * message still work exactly as before, just against the edited content.
 *
 * @param {Object} params
 * @param {import("@slack/bolt").AckFn<any>} params.ack
 * @param {import("@slack/bolt").SlackViewAction} params.body
 * @param {import("@slack/bolt").types.ViewOutput} params.view
 * @param {import("@slack/web-api").WebClient} params.client
 * @param {import("@slack/logger").Logger} params.logger
 */
export const draftEditSubmitCallback = async ({ ack, body, view, client, logger }) => {
  try {
    await ack();

    const { slug, channel_id, message_ts } = JSON.parse(view.private_metadata);
    const draftPath = path.join(DRAFTS_DIR, `${slug}.md`);
    if (!fs.existsSync(draftPath)) return; // approved/rejected while the modal was open

    const newTitle = view.state.values.title_block.title_input.value;
    const newBody = view.state.values.body_block.body_input.value;

    const original = fs.readFileSync(draftPath, 'utf-8');
    const frontmatterMatch = original.match(/^---\n([\s\S]*?)\n---\n\n?/);
    const frontmatterLines = (frontmatterMatch?.[1] || '').split('\n').filter((l) => !l.startsWith('title:'));
    frontmatterLines.push(`title: ${newTitle}`, `edited_by: ${body.user.id}`, `edited_at: ${new Date().toISOString()}`);

    const rewritten = `---\n${frontmatterLines.join('\n')}\n---\n\n${newBody}\n`;
    fs.writeFileSync(draftPath, rewritten);

    // Refresh the review message so the reviewer (and anyone else in the
    // DM) sees the edited title and knows it was hand-edited, while
    // leaving the original Approve/Edit/Reject actions block untouched.
    const history = await client.conversations.history({ channel: channel_id, latest: message_ts, inclusive: true, limit: 1 });
    const existingBlocks = history.messages?.[0]?.blocks || [];
    const actionsBlock = existingBlocks.find((b) => b.block_id === 'draft_review');
    const contextBlock = existingBlocks.find((b) => b.type === 'context');

    await client.chat.update({
      channel: channel_id,
      ts: message_ts,
      text: `New doc draft ready for review: ${newTitle}`,
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: `*New doc draft ready for review*\n*${newTitle}*\n_Edited by <@${body.user.id}>_` },
        },
        ...(contextBlock ? [contextBlock] : []),
        ...(actionsBlock ? [actionsBlock] : []),
      ],
    });
  } catch (error) {
    logger.error(`:warning: Something went wrong saving the edited draft! ${error}`);
  }
};
