import fs from 'node:fs';
import path from 'node:path';
import { readJSON, withFileLockSync, writeJSONAtomic } from '../../agent/store.js';
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
  withFileLockSync(DOC_OWNERS_PATH, () => {
    const owners = readJSON(DOC_OWNERS_PATH, {});

    const topicTags = (title || slug)
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);

    owners[`${slug}.md`] = {
      owner: approverId,
      topic_tags: topicTags,
    };

    writeJSONAtomic(DOC_OWNERS_PATH, owners);
  });
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
      await client.chat.delete({
        channel: channel_id,
        ts: message_ts,
      });
      return;
    }

    if (action.action_id === 'draft_approve') {
      const claimed = withFileLockSync(draftPath, () => {
        // Re-check inside the lock — an Edit submission or a duplicate
        // button click may have already consumed this draft.
        if (!fs.existsSync(draftPath)) return null;

        const text = fs.readFileSync(draftPath, 'utf-8');
        const frontmatterMatch = text.match(/^---\n([\s\S]*?)\n---\n\n?/);
        const body_ = text.replace(/^---\n[\s\S]*?\n---\n\n?/, ''); // strip frontmatter before ingesting
        const titleLine = frontmatterMatch?.[1].match(/^title:\s*(.+)$/m);
        const title = titleLine?.[1].trim();

        // Correction drafts carry an `edit_of: <docSource>` frontmatter field
        // (see draftCorrection() in agent/draft-generator.js). Those must
        // overwrite the doc they're correcting, not land under a new slug —
        // otherwise the stale/wrong original stays live and the "correction"
        // just becomes an orphaned second document.
        const editOfLine = frontmatterMatch?.[1].match(/^edit_of:\s*(.+)$/m);
        const editOf = editOfLine?.[1].trim();
        const targetFileName = editOf || `${slug}.md`;

        fs.mkdirSync(DOCS_DIR, { recursive: true });
        fs.renameSync(draftPath, path.join(DOCS_DIR, targetFileName));

        return { title, editOf, targetFileName, body_ };
      });

      if (!claimed) {
        await client.chat.delete({
          channel: channel_id,
          ts: message_ts,
        });
        return;
      }

      const { title, editOf, targetFileName, body_ } = claimed;
      await ingestText(targetFileName, body_);
      recordAuthorAsOwner(editOf ? editOf.replace(/\.md$/, '') : slug, title, body.user?.id);

      await client.chat.update({
        channel: channel_id,
        ts: message_ts,
        text: 'Draft approved and added to the knowledge base.',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: editOf
                ? `:white_check_mark: Approved — *${targetFileName}* was updated in the knowledge base.`
                : `:white_check_mark: Approved — *${slug}* is now live in the knowledge base.`,
            },
          },
        ],
      });
    } else {
      const removed = withFileLockSync(draftPath, () => {
        if (!fs.existsSync(draftPath)) return false;
        fs.unlinkSync(draftPath);
        return true;
      });

      if (!removed) {
        await client.chat.delete({
          channel: channel_id,
          ts: message_ts,
        });
        return;
      }

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
