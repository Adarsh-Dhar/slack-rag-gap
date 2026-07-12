import { assignOwner, loadDocOwners } from '../../agent/doc-owners.js';
import { draftCorrection } from '../../agent/draft-generator.js';
import { notifyStakeholder } from '../../agent/notify-stakeholder.js';
import { assignProcessOwner, loadProcessOwners } from '../../agent/process-owners.js';
import { getLastAnswerForThread, logIncomingMessage } from '../../agent/rag.js';
import { judgeFollowUp } from '../../agent/thread-resolver.js';
import { parseOwnerCommand, parseProcessOwnerCommand } from './app_mention.js';

/**
 * Handles follow-up messages posted in a thread where the bot previously
 * answered a question. Classifies the reply as resolved / follow-up / correction
 * and, for corrections, drafts a minimal edit and notifies the doc owner.
 *
 * This is registered as a 'message' event listener in events/index.js and
 * only fires when:
 *   - The message has a thread_ts (is a reply in a thread)
 *   - The message is NOT from the bot itself
 *   - The thread has a logged retrieveContext entry (i.e. the bot answered in it)
 *
 * @param {Object} params
 * @param {import("@slack/types").MessageEvent} params.event
 * @param {import("@slack/web-api").WebClient} params.client
 * @param {import("@slack/logger").Logger} params.logger
 */
export async function threadReplyCallback({ event, client, logger }) {
  const { channel, thread_ts, text, user } = event;

  // Only process threaded replies that aren't the bot's own messages
  if (!thread_ts || !text || !user) return;

  logIncomingMessage(text, { channel, thread_ts, source: 'thread_reply' });

  // Handle ownership commands (assign/set/transfer/who/list) before anything else.
  // These must work even in threads where the bot previously answered.
  //
  // Parse from raw text — the "assign" regex needs the target <@USERID>
  // mention intact.  cleanText strips mentions, which would break "assign
  // owner of X to <@USER>".
  const _cleanText = text.replace(/<@[A-Z0-9]+>/g, '').trim();

  // Process-owner commands are checked first — "who owns process X" would
  // otherwise be swallowed by the doc-owner "who owns" pattern below.
  const processOwnerCmd = parseProcessOwnerCommand(text);
  if (processOwnerCmd) {
    try {
      if (processOwnerCmd.type === 'assign') {
        const result = assignProcessOwner(
          processOwnerCmd.topicName,
          processOwnerCmd.newOwnerId,
          user,
          processOwnerCmd.keywords,
        );
        await client.chat.postMessage({ channel, thread_ts, text: result.message });
      } else if (processOwnerCmd.type === 'who') {
        const owners = loadProcessOwners();
        const key = processOwnerCmd.topicName.trim().toLowerCase().replace(/\s+/g, '-');
        const entry = owners[key];
        const owner = entry?.owner;
        const response = owner?.startsWith('U')
          ? `The process owner for *${key}* is <@${owner}>.`
          : `*${key}* has no assigned process owner yet. Use \`assign process owner of ${processOwnerCmd.topicName} to @user\` to set one.`;
        await client.chat.postMessage({ channel, thread_ts, text: response });
      } else if (processOwnerCmd.type === 'list') {
        const owners = loadProcessOwners();
        const entries = Object.entries(owners).filter(([k]) => !k.startsWith('_'));
        const response =
          entries.length > 0
            ? '*Process owners:*\n' +
              entries
                .map(([topic, info]) => {
                  const owner = info.owner?.startsWith('U') ? `<@${info.owner}>` : '_unassigned_';
                  return `• *${topic}* — ${owner}`;
                })
                .join('\n')
            : 'No process owners have been tagged yet.';
        await client.chat.postMessage({ channel, thread_ts, text: response });
      }
    } catch (err) {
      logger.error(`threadReplyCallback: process owner command failed: ${err.message}`);
    }
    return; // Don't also process as a correction
  }

  const ownerCmd = parseOwnerCommand(text);
  if (ownerCmd) {
    try {
      if (ownerCmd.type === 'assign') {
        const result = assignOwner(ownerCmd.docName, ownerCmd.newOwnerId, user);
        await client.chat.postMessage({ channel, thread_ts, text: result.message });
      } else if (ownerCmd.type === 'who') {
        const owners = loadDocOwners();
        const key = ownerCmd.docName.endsWith('.md') ? ownerCmd.docName : `${ownerCmd.docName}.md`;
        const entry = owners[key];
        const owner = entry?.owner;
        const response = owner?.startsWith('U')
          ? `The owner of *${key}* is <@${owner}>.`
          : `*${key}* has no assigned owner yet. Use \`assign owner of ${ownerCmd.docName} to @user\` to set one.`;
        await client.chat.postMessage({ channel, thread_ts, text: response });
      } else if (ownerCmd.type === 'list') {
        const owners = loadDocOwners();
        const entries = Object.entries(owners).filter(([k]) => !k.startsWith('_'));
        const response =
          entries.length > 0
            ? '*Document owners:*\n' +
              entries
                .map(([doc, info]) => {
                  const owner = info.owner?.startsWith('U') ? `<@${info.owner}>` : '_unassigned_';
                  return `• *${doc}* — ${owner}`;
                })
                .join('\n')
            : 'No documents have been registered yet.';
        await client.chat.postMessage({ channel, thread_ts, text: response });
      }
    } catch (err) {
      logger.error(`threadReplyCallback: owner command failed: ${err.message}`);
    }
    return; // Don't also process as a correction
  }

  // Look up the original bot answer for this thread
  const lastAnswer = getLastAnswerForThread(channel, thread_ts);
  if (!lastAnswer) {
    logger.debug(`threadReplyCallback: no logged answer for channel=${channel} thread=${thread_ts} — ignoring`);
    return; // thread not started by the bot — ignore
  }

  const { question, sources, answerText } = lastAnswer;
  logger.info(
    `threadReplyCallback: evaluating reply in thread ${thread_ts} — question="${question?.slice(0, 60)}" sources=${sources}`,
  );

  if (sources.length === 0) {
    logger.info(`threadReplyCallback: bot answered with no sources — nothing to correct`);
    return;
  }

  let label, correctedText, correctedSources;
  try {
    ({ label, correctedText, correctedSources } = await judgeFollowUp(question, sources, [{ user, text }], answerText));
  } catch (err) {
    logger.error(`threadReplyCallback: judgeFollowUp failed: ${err.message}`);
    return;
  }

  logger.info(`threadReplyCallback: judgeFollowUp label="${label}" correctedText="${correctedText?.slice(0, 80)}"`);

  if (label !== 'correction') return; // nothing to draft

  // Pick the first implicated source, falling back to the first cited source
  const docSource = correctedSources.length > 0 ? correctedSources[0] : sources[0];

  let draft;
  try {
    const { permalink } = await client.chat.getPermalink({
      channel,
      message_ts: thread_ts,
    });
    draft = await draftCorrection({ docSource, correctionText: correctedText, permalink });
  } catch (err) {
    logger.error(`threadReplyCallback: draftCorrection failed for "${docSource}": ${err.message}`);
    return;
  }

  // Look up the doc owner; fall back to STAKEHOLDER_USER_ID with a warning
  const docOwners = loadDocOwners();
  const ownerId = docOwners[docSource]?.owner ?? null;
  if (!ownerId) {
    logger.warn(
      `threadReplyCallback: no owner found for "${docSource}" in doc-owners.json — falling back to STAKEHOLDER_USER_ID`,
    );
  }

  let notifyFailed = false;
  try {
    await notifyStakeholder(client, { ...draft, permalink: draft.filePath }, ownerId);
  } catch (err) {
    notifyFailed = true;
    logger.error(`threadReplyCallback: notifyStakeholder failed: ${err.message}`);
  }

  // Always confirm to the user that the correction was captured, even if
  // the DM notification failed — the draft file still exists in docs/drafts/.
  try {
    const msg = notifyFailed
      ? `Got it — I've captured that correction for review. (Note: couldn't notify the doc owner, but the draft has been saved.)`
      : `Got it — I've flagged that correction for review. The doc owner will be notified to update *${docSource}*.`;
    await client.chat.postMessage({ channel, thread_ts, text: msg });
  } catch (err) {
    logger.error(`threadReplyCallback: failed to post confirmation: ${err.message}`);
  }
}
