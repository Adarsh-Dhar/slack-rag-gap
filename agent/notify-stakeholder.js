import { isRetryableSlackError, withRetry } from './with-retry.js';

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
  const { channel } = await withRetry(() => client.conversations.open({ users: targetUserId }), {
    isRetryable: isRetryableSlackError,
    label: 'notifyStakeholder conversations.open',
  });
  const dmChannelId = channel.id;

  await withRetry(
    () =>
      client.chat.postMessage({
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
            ? [
                {
                  type: 'section',
                  text: { type: 'mrkdwn', text: `\`\`\`\n${draft.diff}\n\`\`\`` },
                },
              ]
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
      }),
    { isRetryable: isRetryableSlackError, label: 'notifyStakeholder postMessage' },
  );
}

/**
 * Proactively asks the routed SME (or default stakeholder) to explain a
 * question that a gap cluster has accumulated hits on, but that nobody has
 * answered yet — the counterpart to notifyStakeholder(), which only fires
 * *after* someone has already explained it somewhere.
 *
 * Sends both:
 *   1. An @-mention reply in the original Slack thread, so anyone else
 *      watching that thread sees the ask and can jump in too.
 *   2. A DM to the same person, so it isn't easy to miss in a busy channel.
 *
 * No dedupe/cooldown by design — if the cluster is still unresolved next
 * time gap-detect runs, it pings again. Tune SCHEDULER_INTERVAL_MS if that
 * cadence is too chatty for your workspace.
 *
 * @param {import("@slack/web-api").WebClient} client
 * @param question: string, hitCount: number, channel: string, thread_ts: string gap
 * @param {string|null} [userId] - Slack user ID to ping. Falls back to
 *   STAKEHOLDER_USER_ID when omitted or null.
 * @param {string} [reason] - Human-readable routing reason, appended to the
 *   DM so the person knows why they were picked.
 */
export async function pingForExplanation(client, gap, userId, reason) {
  const targetUserId = userId || process.env.STAKEHOLDER_USER_ID;
  if (!targetUserId) {
    console.warn('No SME resolved and STAKEHOLDER_USER_ID not set — skipping explanation ping.');
    return;
  }

  const { question, hitCount, channel, thread_ts } = gap;
  const plural = hitCount === 1 ? 'person has' : 'people have';
  const askText = `<@${targetUserId}> ${hitCount} ${plural} asked something like this and I don't have a doc for it yet: *"${question}"*\nCould you explain it in a couple sentences here? I'll turn it into a doc automatically.`;

  // 1. Reply in the original thread — visible to anyone else following along.
  try {
    await withRetry(() => client.chat.postMessage({ channel, thread_ts, text: askText }), {
      isRetryable: isRetryableSlackError,
      label: 'pingForExplanation in-thread postMessage',
    });
  } catch (err) {
    console.error(`pingForExplanation: failed to post in-thread ping: ${err.message}`);
  }

  // 2. DM the same ask directly, so it's not easy to miss.
  try {
    const { channel: dm } = await withRetry(() => client.conversations.open({ users: targetUserId }), {
      isRetryable: isRetryableSlackError,
      label: 'pingForExplanation conversations.open',
    });
    await withRetry(
      () =>
        client.chat.postMessage({
          channel: dm.id,
          text: `A doc gap needs your input: "${question}"`,
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `*${hitCount} ${plural} asked this and there's no doc yet:*\n"${question}"`,
              },
            },
            {
              type: 'context',
              elements: [
                {
                  type: 'mrkdwn',
                  text: `Reply in the thread and I'll draft a doc from it${reason ? ` · routed via ${reason}` : ''}`,
                },
              ],
            },
          ],
        }),
      { isRetryable: isRetryableSlackError, label: 'pingForExplanation DM postMessage' },
    );
  } catch (err) {
    console.error(`pingForExplanation: failed to DM ${targetUserId}: ${err.message}`);
  }
}
