/**
 * DMs the routed SME (or the default stakeholder, if no SME could be
 * resolved) a draft stub for review.
 *
 * @param {import("@slack/web-api").WebClient} client
 * @param {{slug: string, title: string, summary: string, permalink: string, diff?: string|null}} draft
 * @param {string|null} [userId] - Slack user ID to notify. Falls back to
 *   STAKEHOLDER_USER_ID when omitted or null (see agent/sme-router.js).
 * @param {string} [reason] - Human-readable routing reason, shown in the
 *   message so reviewers can tell why they were picked.
 */
export async function notifyStakeholder(client, draft, userId, reason) {
  const targetUserId = userId || process.env.STAKEHOLDER_USER_ID;
  if (!targetUserId) {
    console.warn('No SME resolved and STAKEHOLDER_USER_ID not set — skipping draft notification.');
    return;
  }

  // On Enterprise Grid, posting to a user ID directly fails with team_not_found.
  // conversations.open returns the correct IM channel ID for any workspace topology.
  const { channel } = await client.conversations.open({ users: targetUserId });
  const dmChannelId = channel.id;

  await client.chat.postMessage({
    channel: dmChannelId,
    text: `New doc draft ready for review: ${draft.title}`,
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*New doc draft ready for review*\n*${draft.title}*\n${draft.summary}` },
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `Source thread: <${draft.permalink}|view conversation>${reason ? ` · routed via ${reason}` : ''}`,
          },
        ],
      },
      ...(draft.diff
        ? [{
            type: 'section',
            text: { type: 'mrkdwn', text: `\`\`\`\n${draft.diff}\n\`\`\`` },
          }]
        : []),
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
            text: { type: 'plain_text', text: 'Edit' },
            action_id: 'draft_edit',
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
