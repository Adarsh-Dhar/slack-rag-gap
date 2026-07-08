import fs from 'fs';
import path from 'path';
import { ingestText } from '../../ingest.js';

const DRAFTS_DIR = path.join(process.cwd(), 'docs', 'drafts');
const DOCS_DIR = path.join(process.cwd(), 'docs');
const DOC_OWNERS_PATH = path.join(process.cwd(), 'doc-owners.json');

/**
 * Author-as-owner: whoever clicks Approve becomes the doc's owner in
 * doc-owners.json, with no separate ownership-assignment step. This is the
 * cheapest-to-implement policy (mirrors how Confluence/Notion/Google Docs
 * implicitly attribute "owner" as "whoever last touched it"), at the cost
 * of ownership silently drifting to the last approver rather than being a
 * deliberate assignment — a stale doc can end up "owned" by someone who's
 * no longer the right person (or no longer on the team).
 *
 * topic_tags are seeded from the draft title so matchDocOwner() in
 * topic-owner.js has something to embed immediately; the approver (or
 * anyone) can edit doc-owners.json by hand later to refine them.
 *
 * @param {string} slug
 * @param {string} title
 * @param {string} approverId
 */
function recordAuthorAsOwner(slug, title, approverId) {
  let owners = {};
  if (fs.existsSync(DOC_OWNERS_PATH)) {
    owners = JSON.parse(fs.readFileSync(DOC_OWNERS_PATH, 'utf-8'));
  }

  const topicTags = (title || slug)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

  owners[`${slug}.md`] = {
    owner: approverId,
    topic_tags: topicTags,
  };

  fs.writeFileSync(DOC_OWNERS_PATH, JSON.stringify(owners, null, 2));
}

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
      const frontmatterMatch = text.match(/^---\n([\s\S]*?)\n---\n\n?/);
      const body_ = text.replace(/^---\n[\s\S]*?\n---\n\n?/, ''); // strip frontmatter before ingesting
      const titleLine = frontmatterMatch?.[1].match(/^title:\s*(.+)$/m);
      const title = titleLine?.[1].trim();

      fs.mkdirSync(DOCS_DIR, { recursive: true });
      fs.renameSync(draftPath, path.join(DOCS_DIR, `${slug}.md`));
      await ingestText(`${slug}.md`, body_);
      recordAuthorAsOwner(slug, title, body.user?.id);

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
