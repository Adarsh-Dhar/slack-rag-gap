import fs from 'fs';
import path from 'path';
import { WebClient } from '@slack/web-api';
import { getLastAnswerForThread } from '../../agent/rag.js';
import { judgeFollowUp } from '../../agent/thread-resolver.js';
import { draftCorrection } from '../../agent/draft-generator.js';
import { notifyStakeholder } from '../../agent/notify-stakeholder.js';

const DOC_OWNERS_PATH = path.join(process.cwd(), 'doc-owners.json');

function loadDocOwners() {
  if (!fs.existsSync(DOC_OWNERS_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(DOC_OWNERS_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

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

  // Look up the original bot answer for this thread
  const lastAnswer = getLastAnswerForThread(channel, thread_ts);
  if (!lastAnswer) {
    logger.debug(`threadReplyCallback: no logged answer for channel=${channel} thread=${thread_ts} — ignoring`);
    return; // thread not started by the bot — ignore
  }

  const { question, sources, answerText } = lastAnswer;
  logger.info(`threadReplyCallback: evaluating reply in thread ${thread_ts} — question="${question?.slice(0, 60)}" sources=${sources}`);

  if (sources.length === 0) {
    logger.info(`threadReplyCallback: bot answered with no sources — nothing to correct`);
    return;
  }

  let label, correctedText, correctedSources;
  try {
    ({ label, correctedText, correctedSources } = await judgeFollowUp(
      question,
      sources,
      [{ user, text }],
      answerText,
    ));
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

  try {
    await notifyStakeholder(client, { ...draft, permalink: draft.filePath }, ownerId);
  } catch (err) {
    logger.error(`threadReplyCallback: notifyStakeholder failed: ${err.message}`);
  }
}
