import { OpenAI } from 'openai';
import { rollDice, rollDiceDefinition } from './tools/dice.js';
import { retrieveContext, logAnswer } from './rag.js';

// OpenAI-compatible client pointed at GitHub Models
const openai = new OpenAI({
  apiKey: process.env.GITHUB_TOKEN,
  baseURL: 'https://models.github.ai/inference',
});

const CHAT_MODEL = 'openai/gpt-4o-mini';

// GitHub Models' endpoint speaks Chat Completions, not the Responses API,
// so tool definitions must be wrapped in the nested `function` shape.
const chatTools = [
  {
    type: 'function',
    function: {
      name: rollDiceDefinition.name,
      description: rollDiceDefinition.description,
      parameters: rollDiceDefinition.parameters,
    },
  },
];

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

  if (isFreshTurn && latestUserMessage) {
    const { context, sources, hasResults } = await retrieveContext(latestUserMessage.content, {
      channel,
      thread_ts,
    });

    const systemContent = hasResults
      ? `Answer only using the provided context. If the context doesn't fully answer the question, say so explicitly rather than guessing. Cite sources by name when relevant.\n\nContext:\n${context}\n\nSources: ${sources.join(', ')}`
      : `No relevant documentation was found for this question. Tell the user you don't have documentation on this topic yet, rather than guessing an answer.`;

    prompts.unshift({ role: 'system', content: systemContent });

    logAnswer(latestUserMessage.content, hasResults ? 'answered' : 'no_docs_found', {
      channel,
      thread_ts,
    });
  }

  const stream = await openai.chat.completions.create({
    model: CHAT_MODEL,
    messages: prompts,
    tools: chatTools,
    tool_choice: 'auto',
    stream: true,
  });

  // Chat Completions streams tool-call *fragments* keyed by array index —
  // unlike the Responses API, we have to manually accumulate them across chunks.
  const toolCallAccumulator = {};
  let finishReason = null;

  for await (const chunk of stream) {
    const delta = chunk.choices?.[0]?.delta;
    finishReason = chunk.choices?.[0]?.finish_reason ?? finishReason;

    if (delta?.content) {
      await streamer.append({ markdown_text: delta.content });
    }

    if (delta?.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index;
        if (!toolCallAccumulator[idx]) {
          toolCallAccumulator[idx] = { id: tc.id, name: '', arguments: '' };
        }
        if (tc.id) toolCallAccumulator[idx].id = tc.id;
        if (tc.function?.name) toolCallAccumulator[idx].name += tc.function.name;
        if (tc.function?.arguments) toolCallAccumulator[idx].arguments += tc.function.arguments;
      }
    }
  }

  const toolCalls = Object.values(toolCallAccumulator);

  if (finishReason === 'tool_calls' && toolCalls.length > 0) {
    // Record the assistant's tool-call request in the conversation
    prompts.push({
      role: 'assistant',
      tool_calls: toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.arguments },
      })),
    });

    for (const call of toolCalls) {
      if (call.name === 'roll_dice') {
        const args = JSON.parse(call.arguments || '{}');

        await streamer.append({
          chunks: [
            {
              type: 'task_update',
              id: call.id,
              title: `Rolling a ${args.count}d${args.sides}...`,
              status: 'in_progress',
            },
          ],
        });

        const result = rollDice(args);

        prompts.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(result),
        });

        await streamer.append({
          chunks: [
            {
              type: 'task_update',
              id: call.id,
              title: result.error ?? result.description ?? 'Completed',
              status: result.error ? 'error' : 'complete',
            },
          ],
        });
      }
    }

    // Continue the conversation now that tool results are available
    await callLLM(streamer, prompts);
  }
}
