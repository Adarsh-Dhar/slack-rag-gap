import { callLLM } from '../../agent/llm-caller.js';
import { getLastAnswerForThread } from '../../agent/rag.js';
import { judgeFollowUp } from '../../agent/thread-resolver.js';
import { draftCorrection } from '../../agent/draft-generator.js';
import { notifyStakeholder } from '../../agent/notify-stakeholder.js';
import { loadDocOwners } from '../../agent/doc-owners.js';

/**
 * Handles when users send messages or select a prompt in an assistant thread
 * and generate AI responses. Also handles follow-up corrections — since the
 * Bolt Assistant class intercepts all im-channel messages before app.event('message'),
 * correction detection must live here too for assistant panel threads.
 */
export const message = async ({ client, context, logger, message, say, setStatus }) => {
  if (!('text' in message) || !('thread_ts' in message) || !message.text || !message.thread_ts) {
    logger.info('assistant message: skipping — missing text or thread_ts');
    return;
  }

  // Only handle messages in DM / assistant panel threads.
  // Channel messages are handled by threadReplyCallback (events/thread_reply.js)
  // and appMentionCallback (events/app_mention.js).
  if (message.channel_type === 'channel' || message.channel_type === 'group') {
    return;
  }

  logger.info(`assistant message received: "${message.text?.slice(0, 80)}"`);

  const { channel, thread_ts, text, user } = message;

  // Check if this is a follow-up reply to a thread the bot already answered.
  // If so, run correction detection BEFORE treating it as a new question.
  const lastAnswer = getLastAnswerForThread(channel, thread_ts);
  if (lastAnswer && lastAnswer.sources.length > 0) {
    logger.info(`assistant message: detected reply to answered thread — running judgeFollowUp`);
    try {
      const { label, correctedText, correctedSources } = await judgeFollowUp(
        lastAnswer.question,
        lastAnswer.sources,
        [{ user, text }],
        lastAnswer.answerText,
      );
      logger.info(`assistant message: judgeFollowUp label="${label}"`);

      if (label === 'correction') {
        const docSource = correctedSources.length > 0 ? correctedSources[0] : lastAnswer.sources[0];
        try {
          const { permalink } = await client.chat.getPermalink({ channel, message_ts: thread_ts });
          const draft = await draftCorrection({ docSource, correctionText: correctedText, permalink });
          const docOwners = loadDocOwners();
          const ownerId = docOwners[docSource]?.owner ?? null;
          if (!ownerId) logger.warn(`assistant message: no owner for "${docSource}" — using STAKEHOLDER_USER_ID`);
          try {
            await notifyStakeholder(client, { ...draft, permalink: draft.filePath }, ownerId);
            logger.info(`assistant message: correction draft sent for "${docSource}"`);
            await say(`Got it — I've flagged that correction for review. The doc owner will be notified to update *${docSource}*.`);
          } catch (notifyErr) {
            logger.error(`assistant message: notifyStakeholder failed: ${notifyErr.message}`);
            await say(`Got it — I've captured that correction for review. (Note: couldn't notify the doc owner, but the draft has been saved.)`);
          }
        } catch (err) {
          logger.error(`assistant message: correction flow failed: ${err.message}`);
        }
        return; // Don't also answer it as a new question
      }
    } catch (err) {
      logger.error(`assistant message: judgeFollowUp failed: ${err.message}`);
      // Fall through to normal answer flow
    }
  }

  try {
    await setStatus('thinking...');

    const streamer = client.chatStream({
      channel: channel,
      recipient_team_id: context.teamId,
      recipient_user_id: context.userId,
      thread_ts: thread_ts,
      task_display_mode: 'timeline',
    });

    const prompts = [{ role: 'user', content: text }];

    await callLLM(streamer, prompts, { channel, thread_ts });
    await streamer.stop();
  } catch (e) {
    logger.error(`Failed to handle a user message event: ${e.stack ?? e}`);
    try {
      await say(`:warning: Something went wrong! (${e.message ?? e})`);
    } catch (sayErr) {
      logger.error(`Failed to send error message to user: ${sayErr.stack ?? sayErr}`);
    }
  }
};
