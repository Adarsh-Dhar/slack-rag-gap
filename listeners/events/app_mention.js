import { callLLM } from '../../agent/llm-caller.js';
import { assignOwner, loadDocOwners } from '../../agent/doc-owners.js';

/**
 * Parses an ownership command from the text (after the bot @mention is stripped).
 * Returns null if the text doesn't match any ownership command pattern.
 *
 * Supported commands:
 *   assign|set|transfer owner of <doc> to <@user>
 *   who owns <doc>
 *   list [doc] owners
 *
 * @param {string} text - Message text with bot @mention already removed
 * @returns {{ type: 'assign'|'who'|'list', docName?: string, newOwnerId?: string } | null}
 */
export function parseOwnerCommand(text) {
  const assignMatch = text.match(
    /^(?:assign|set|transfer)\s+owner(?:ship)?\s+(?:of|for)\s+(.+?)\s+to\s+<@([A-Z0-9]+)>/i,
  );
  if (assignMatch) {
    return { type: 'assign', docName: assignMatch[1].trim(), newOwnerId: assignMatch[2] };
  }

  const whoMatch = text.match(/^who\s+owns\s+(.+)/i);
  if (whoMatch) {
    return { type: 'who', docName: whoMatch[1].trim() };
  }

  if (/^list\s+(?:doc\s+)?owners/i.test(text.trim())) {
    return { type: 'list' };
  }

  return null;
}

/**
 * Handles the event when the app is mentioned in a Slack conversation.
 * Ownership commands (assign/set/transfer/who/list) are processed here
 * regardless of threading. All other threaded @mentions are deferred to
 * threadReplyCallback (events/thread_reply.js).
 */
export const appMentionCallback = async ({ event, client, logger, say }) => {
  console.log(`[app_mention] ts=${event.ts} thread_ts=${event.thread_ts ?? 'none'} text="${event.text?.slice(0, 80)}"`);
  try {
    const { channel, text, team, user } = event;
    const thread_ts = event.thread_ts || event.ts;

    // Strip the bot @mention prefix from the text for command parsing
    const cleanText = text.replace(/<@[A-Z0-9]+>\s*/, '').trim();
    const ownerCmd = parseOwnerCommand(cleanText);
    console.log(`[app_mention] cleanText="${cleanText}" ownerCmd=${JSON.stringify(ownerCmd)}`);

    if (ownerCmd) {
      if (ownerCmd.type === 'assign') {
        const result = assignOwner(ownerCmd.docName, ownerCmd.newOwnerId, user);
        await say({ text: result.message, thread_ts });
        return;
      }

      if (ownerCmd.type === 'who') {
        const owners = loadDocOwners();
        const key = ownerCmd.docName.endsWith('.md') ? ownerCmd.docName : `${ownerCmd.docName}.md`;
        const entry = owners[key];
        const owner = entry?.owner;
        const response = owner && owner.startsWith('U')
          ? `The owner of *${key}* is <@${owner}>.`
          : `*${key}* has no assigned owner yet. Use \`assign owner of ${ownerCmd.docName} to @user\` to set one.`;
        await say({ text: response, thread_ts });
        return;
      }

      if (ownerCmd.type === 'list') {
        const owners = loadDocOwners();
        const entries = Object.entries(owners).filter(([k]) => !k.startsWith('_'));
        const response = entries.length > 0
          ? '*Document owners:*\n' + entries
              .map(([doc, info]) => {
                const owner = info.owner && info.owner.startsWith('U') ? `<@${info.owner}>` : '_unassigned_';
                return `• *${doc}* — ${owner}`;
              })
              .join('\n')
          : 'No documents have been registered yet.';
        await say({ text: response, thread_ts });
        return;
      }
    }

    // Skip threaded @mentions — threadReplyCallback handles corrections
    // and follow-ups for replies in threads where the bot already answered.
    if (event.thread_ts) {
      logger.info(`app_mention: threaded reply detected — deferring to threadReplyCallback`);
      return;
    }

    const streamer = client.chatStream({
      channel: channel,
      recipient_team_id: team,
      recipient_user_id: user,
      thread_ts: thread_ts,
    });

    await callLLM(streamer, [{ role: 'user', content: text }], { channel, thread_ts });
    await streamer.stop();
  } catch (e) {
    logger.error(`app_mention: failed: ${e.stack ?? e}`);
    await say(`:warning: Something went wrong! (${e.message ?? e})`);
  }
};
