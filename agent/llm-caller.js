import { getOpenAI } from './openai-client.js';
import { logAnswer, retrieveContext } from './rag.js';
import { isRetryableLLMError, withRetry } from './with-retry.js';

const CHAT_MODEL = 'openai/gpt-4o-mini';

/**
 * Stream a Chat Completions response, grounded in retrieved document context.
 *
 * @param {import("@slack/web-api").ChatStreamer} streamer - Slack chat stream
 * @param {any[]} prompts - Chat Completions-style messages ({role, content})
 *
 * @see {@link https://docs.slack.dev/tools/bolt-js/web#sending-streaming-messages}
 * @see {@link https://docs.github.com/en/rest/models/inference}
 */
export async function callLLM(streamer, prompts, { channel, thread_ts } = {}) {
  const isFreshTurn = !prompts.some((p) => p.role === 'system');
  const latestUserMessage = [...prompts].reverse().find((p) => p.role === 'user');

  let _logAnswerArgs = null; // captured for post-stream logging

  if (isFreshTurn && latestUserMessage) {
    const { context, sources, hasResults } = await retrieveContext(latestUserMessage.content, {
      channel,
      thread_ts,
    });

    const systemContent = hasResults
      ? `Answer only using the provided context. If the context doesn't fully answer the question, say so explicitly rather than guessing. Cite sources by name when relevant.\n\nContext:\n${context}\n\nSources: ${sources.join(', ')}`
      : `No relevant documentation was found for this question. Tell the user you don't have documentation on this topic yet, rather than guessing an answer.`;

    prompts.unshift({ role: 'system', content: systemContent });

    // Store args — we'll call logAnswer after streaming so we have the actual answer text
    _logAnswerArgs = { question: latestUserMessage.content, channel, thread_ts };
  }

  // Only retry stream *creation* — retrying mid-stream would duplicate
  // tokens already sent to the user.
  const stream = await withRetry(
    () =>
      getOpenAI().chat.completions.create({
        model: CHAT_MODEL,
        messages: prompts,
        stream: true,
      }),
    { isRetryable: isRetryableLLMError, label: 'callLLM completion' },
  );

  let accumulatedText = ''; // collect answer text for logAnswer

  for await (const chunk of stream) {
    const delta = chunk.choices?.[0]?.delta;

    if (delta?.content) {
      accumulatedText += delta.content;
      await streamer.append({ markdown_text: delta.content });
    }
  }

  // Log the actual answer text now that we have it
  if (_logAnswerArgs) {
    logAnswer(_logAnswerArgs.question, accumulatedText, {
      channel: _logAnswerArgs.channel,
      thread_ts: _logAnswerArgs.thread_ts,
    });
  }
}
