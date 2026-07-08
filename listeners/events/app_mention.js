import { callLLM } from '../../agent/llm-caller.js';
import { feedbackBlock } from '../views/feedback_block.js';
import { getLastAnswerForThread } from '../../agent/rag.js';
import { judgeFollowUp } from '../../agent/thread-resolver.js';
import { draftCorrection } from '../../agent/draft-generator.js';
import { notifyStakeholder } from '../../agent/notify-stakeholder.js';
import fs from 'fs';
import path from 'path';

const DOC_OWNERS_PATH = path.join(process.cwd(), 'doc-owners.json');
function loadDocOwners() {
  if (!fs.existsSync(DOC_OWNERS_PATH)) return {};
  try { return JSON.parse(fs.readFileSync(DOC_OWNERS_PATH, 'utf-8')); } catch { return {}; }
}

/**
 * Handles the event when the app is mentioned in a Slack conversation.
 * If the mention is a reply in a thread the bot already answered, runs
 * correction detection first before treating it as a new question.
 */
export const appMentionCallback = async ({ event, client, logger, say }) => {
  console.log(`[app_mention] ts=${event.ts} thread_ts=${event.thread_ts ?? 'none'} text="${event.text?.slice(0, 80)}"`);
  try {
    const { channel, text, team, user } = event;
    const thread_ts = event.thread_ts || event.ts;

    // If this @mention is a reply in a thread the bot already answered,
    // check for corrections before answering as a new question.
    if (event.thread_ts) {
      const lastAnswer = getLastAnswerForThread(channel, event.thread_ts);
      console.log(`[app_mention] thread reply — lastAnswer=${JSON.stringify(lastAnswer?.question?.slice(0,40))} sources=${JSON.stringify(lastAnswer?.sources)}`);
      if (lastAnswer && lastAnswer.sources.length > 0) {
        logger.info(`app_mention: reply in answered thread — running judgeFollowUp`);
        try {
          const { label, correctedText, correctedSources } = await judgeFollowUp(
            lastAnswer.question,
            lastAnswer.sources,
            [{ user, text }],
            lastAnswer.answerText,
          );
          console.log(`[app_mention] judgeFollowUp label="${label}" correctedText="${correctedText?.slice(0,60)}"`);
          logger.info(`app_mention: judgeFollowUp label="${label}"`);
          if (label === 'correction') {
            const docSource = correctedSources.length > 0 ? correctedSources[0] : lastAnswer.sources[0];
            const { permalink } = await client.chat.getPermalink({ channel, message_ts: event.thread_ts });
            const draft = await draftCorrection({ docSource, correctionText: correctedText, permalink });
            const ownerId = loadDocOwners()[docSource]?.owner ?? null;
            await notifyStakeholder(client, { ...draft, permalink: draft.filePath }, ownerId);
            await say({ text: `Got it — I've flagged that correction for review. The doc owner will be notified to update *${docSource}*.`, thread_ts });
            return;
          }
        } catch (err) {
          logger.error(`app_mention: correction flow failed: ${err.message}`);
          // Fall through to normal answer
        }
      }
    }

    const streamer = client.chatStream({
      channel: channel,
      recipient_team_id: team,
      recipient_user_id: user,
      thread_ts: thread_ts,
    });

    await callLLM(streamer, [{ role: 'user', content: text }], { channel, thread_ts });
    await streamer.stop({ blocks: [feedbackBlock] });
  } catch (e) {
    logger.error(`app_mention: failed: ${e.stack ?? e}`);
    await say(`:warning: Something went wrong! (${e.message ?? e})`);
  }
};
