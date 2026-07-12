import fs from 'node:fs';
import path from 'node:path';

const DRAFTS_DIR = path.join(process.cwd(), 'docs', 'drafts');

/**
 * Splits a draft file into its frontmatter block and body text.
 *
 * @param {string} text
 * @returns {{frontmatter: string, title: string, body: string}}
 */
function splitDraft(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n\n?/);
  const frontmatter = match?.[1] || '';
  const titleLine = frontmatter.match(/^title:\s*(.+)$/m);
  return {
    frontmatter,
    title: titleLine?.[1].trim() || '',
    body: text.replace(/^---\n[\s\S]*?\n---\n\n?/, ''),
  };
}

/**
 * Handles the Edit button from notify-stakeholder.js. Opens a modal
 * pre-filled with the draft's current title and body so the reviewer can
 * fix it up before it goes live, instead of only being able to accept the
 * AI's draft as-is or throw it away.
 *
 * The draft itself isn't touched here — only on modal submission (see
 * listeners/views/draft_edit_submit.js) — so clicking Edit and then closing
 * the modal without saving is a no-op.
 *
 * @param {Object} params
 * @param {import("@slack/bolt").AckFn<any>} params.ack
 * @param {import("@slack/bolt").SlackAction} params.body
 * @param {import("@slack/web-api").WebClient} params.client
 * @param {import("@slack/logger").Logger} params.logger
 */
export const draftEditCallback = async ({ ack, body, client, logger }) => {
  try {
    await ack();
    if (body.type !== 'block_actions') return;

    const slug = body.actions[0].value;
    const channel_id = body.channel?.id;
    const message_ts = body.message?.ts;
    const draftPath = path.join(DRAFTS_DIR, `${slug}.md`);

    if (!fs.existsSync(draftPath)) {
      await client.chat.postEphemeral({
        channel: channel_id,
        user: body.user.id,
        text: 'Draft not found — it may have already been handled.',
      });
      return;
    }

    const { title, body: draftBody } = splitDraft(fs.readFileSync(draftPath, 'utf-8'));

    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        callback_id: 'draft_edit_modal',
        private_metadata: JSON.stringify({ slug, channel_id, message_ts }),
        title: { type: 'plain_text', text: 'Edit draft' },
        submit: { type: 'plain_text', text: 'Save' },
        close: { type: 'plain_text', text: 'Cancel' },
        blocks: [
          {
            type: 'input',
            block_id: 'title_block',
            label: { type: 'plain_text', text: 'Title' },
            element: {
              type: 'plain_text_input',
              action_id: 'title_input',
              initial_value: title,
            },
          },
          {
            type: 'input',
            block_id: 'body_block',
            label: { type: 'plain_text', text: 'Body (Markdown)' },
            element: {
              type: 'plain_text_input',
              action_id: 'body_input',
              multiline: true,
              initial_value: draftBody,
            },
          },
        ],
      },
    });
  } catch (error) {
    logger.error(`:warning: Something went wrong opening the draft edit modal! ${error}`);
  }
};
