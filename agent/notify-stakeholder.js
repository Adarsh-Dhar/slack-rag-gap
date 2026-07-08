/**
 * DMs the configured stakeholder a draft stub for review.
 *
 * @param {import("@slack/web-api").WebClient} client
 * @param {{slug: string, title: string, summary: string, permalink: string}} draft
 */
export async function notifyStakeholder(client, draft) {
  const userId = process.env.STAKEHOLDER_USER_ID;
  if (!userId) {
    console.warn('STAKEHOLDER_USER_ID not set — skipping draft notification.');
    return;
  }

  await client.chat.postMessage({
    channel: userId, // DMing a user ID opens/uses the IM channel directly
    text: `New doc draft ready for review: ${draft.title}`,
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*New doc draft ready for review*\n*${draft.title}*\n${draft.summary}` },
      },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `Source thread: <${draft.permalink}|view conversation>` }],
      },
      {
        type: 'actions',
        block_id: 'draft_review',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Approve' },
            style: 'primary',
            action_id: 'draft_approve',
            value: draft.slug,
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Reject' },
            style: 'danger',
            action_id: 'draft_reject',
            value: draft.slug,
          },
        ],
      },
    ],
  });
}
