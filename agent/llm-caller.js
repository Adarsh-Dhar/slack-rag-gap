import { OpenAI } from 'openai';
import { rollDice, rollDiceDefinition } from './tools/dice.js';

// GitHub Models LLM client
const openai = new OpenAI({
  baseURL: 'https://models.github.ai/inference',
  apiKey: process.env.GITHUB_TOKEN,
});

/**
 * Stream an LLM response to prompts with an example dice rolling function
 *
 * @param {import("@slack/web-api").ChatStreamer} streamer - Slack chat stream
 * @param {any[]} prompts - OpenAI response messages
 *
 * @see {@link https://docs.slack.dev/tools/bolt-js/web#sending-streaming-messages}
 * @see {@link https://docs.github.com/en/rest/models/inference}
 */
export async function callLLM(streamer, prompts) {
  const toolCalls = new Map();

  const response = await openai.chat.completions.create({
    model: 'openai/gpt-4o-mini',
    messages: prompts,
    tools: [rollDiceDefinition],
    tool_choice: 'auto',
    stream: true,
  });

  for await (const chunk of response) {
    const delta = chunk.choices?.[0]?.delta;
    if (!delta) continue;

    // Stream markdown text from the LLM response as it arrives
    if (delta.content) {
      await streamer.append({
        markdown_text: delta.content,
      });
    }

    // Collect tool calls
    if (delta.tool_calls) {
      for (const toolCall of delta.tool_calls) {
        const index = toolCall.index;

        if (!toolCalls.has(index)) {
          toolCalls.set(index, {
            id: toolCall.id,
            name: toolCall.function?.name || '',
            arguments: '',
          });

          if (toolCall.function?.name === 'roll_dice') {
            await streamer.append({
              chunks: [
                {
                  type: 'task_update',
                  id: toolCall.id,
                  title: 'Processing dice roll...',
                  status: 'in_progress',
                },
              ],
            });
          }
        }

        const existing = toolCalls.get(index);
        if (toolCall.function?.arguments) {
          existing.arguments += toolCall.function.arguments;
        }
        if (toolCall.id) {
          existing.id = toolCall.id;
        }
        if (toolCall.function?.name) {
          existing.name = toolCall.function.name;
        }
      }
    }
  }

  // Perform tool calls and marks tasks as completed
  if (toolCalls.size > 0) {
    for (const [, call] of toolCalls) {
      if (call.name === 'roll_dice') {
        const args = JSON.parse(call.arguments);

        prompts.push({
          role: 'assistant',
          tool_calls: [
            {
              id: call.id,
              type: 'function',
              function: {
                name: 'roll_dice',
                arguments: call.arguments,
              },
            },
          ],
        });

        const result = rollDice(args);

        prompts.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(result),
        });

        if (result.error != null) {
          await streamer.append({
            chunks: [
              {
                type: 'task_update',
                id: call.id,
                title: result.error,
                status: 'error',
              },
            ],
          });
        } else {
          await streamer.append({
            chunks: [
              {
                type: 'task_update',
                id: call.id,
                title: result.description ?? 'Completed',
                status: 'complete',
              },
            ],
          });
        }
      }
    }

    // complete the llm response after making tool calls
    await callLLM(streamer, prompts);
  }
}
