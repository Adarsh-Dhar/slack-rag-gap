import fs from 'fs';
import path from 'path';
import { ingestText } from '../../ingest.js';

const DRAFTS_DIR = path.join(process.cwd(), 'docs', 'drafts');
const DOCS_DIR = path.join(process.cwd(), 'docs');

/**
 * Handles the Approve/Reject buttons from notify-stakeholder.js.
 *
 * @param {Object} params
 * @param {import("@slack/bolt").AckFn<any>} params.ack
 * @param {import("@slack/bolt").SlackAction} params.body
 * @param {import("@slack/web-api").WebClient} params.client
 * @param {import("@slack/logger").Logger} params.logger
 */
export const draftApprovalCallback = async ({ ack, body, client, logger }) => {
  try {
    await ack();
    if (body.type !== 'block_actions') return;

    const action = body.actions[0];
    const slug = action.value;
    const channel_id = body.channel?.id;
    const message_ts = body.message?.ts;
    const draftPath = path.join(DRAFTS_DIR, `${slug}.md`);

    if (!fs.existsSync(draftPath)) {
      await client.chat.postMessage({ channel: channel_id, thread_ts: message_ts, text: 'Draft not found — it may have already been handled.' });
      return;
    }

    if (action.action_id === 'draft_approve') {
      const text = fs.readFileSync(draftPath, 'utf-8');
      const body_ = text.replace(/^---\n[\s\S]*?\n---\n\n?/, ''); // strip frontmatter before ingesting

      fs.mkdirSync(DOCS_DIR, { recursive: true });
      fs.renameSync(draftPath, path.join(DOCS_DIR, `${slug}.md`));
      await ingestText(`${slug}.md`, body_);

      await client.chat.update({
        channel: channel_id,
        ts: message_ts,
        text: 'Draft approved and added to the knowledge base.',
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `:white_check_mark: Approved — *${slug}* is now live in the knowledge base.` } }],
      });
    } else {
      fs.unlinkSync(draftPath);
      await client.chat.update({
        channel: channel_id,
        ts: message_ts,
        text: 'Draft rejected.',
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `:x: Rejected — *${slug}* was discarded.` } }],
      });
    }
  } catch (error) {
    logger.error(`:warning: Something went wrong in draft approval! ${error}`);
  }
};
