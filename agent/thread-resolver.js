import { OpenAI } from 'openai';

const openai = new OpenAI({
  apiKey: process.env.GITHUB_TOKEN,
  baseURL: 'https://models.github.ai/inference',
});
const CHAT_MODEL = 'openai/gpt-4o-mini';

/**
 * Given the original gap question and the replies that followed it in the
 * Slack thread, decide whether a human ever actually answered it — not just
 * "did someone reply" (could be "lol idk", an emoji, someone else asking the
 * same question, etc).
 *
 * @param {string} question
 * @param {{user: string, text: string}[]} replies - thread replies after the bot's message, bot's own replies excluded
 * @returns {Promise<{resolved: boolean, resolvingText: string|null, resolvingUser: string|null, reason: string}>}
 */
export async function judgeResolution(question, replies) {
  if (replies.length === 0) {
    return { resolved: false, resolvingText: null, resolvingUser: null, reason: 'no replies' };
  }

  const transcript = replies.map((r, i) => `[${i}] ${r.text}`).join('\n');

  const res = await openai.chat.completions.create({
    model: CHAT_MODEL,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          'You judge whether a Slack thread reply actually answers a question, ' +
          'versus small talk, a punt, or another question. Respond only with JSON: ' +
          '{"resolved": boolean, "resolving_index": number|null, "reason": string}. ' +
          'resolving_index is the index of the single best answering reply, or null if none resolve it.',
      },
      {
        role: 'user',
        content: `Question: ${question}\n\nReplies:\n${transcript}`,
      },
    ],
  });

  const parsed = JSON.parse(res.choices[0].message.content);
  const resolvingReply =
    parsed.resolved && parsed.resolving_index != null ? replies[parsed.resolving_index] ?? null : null;
  const resolvingText = resolvingReply?.text ?? null;
  const resolvingUser = resolvingReply?.user ?? null;

  return {
    resolved: Boolean(parsed.resolved) && resolvingText != null,
    resolvingText,
    resolvingUser,
    reason: parsed.reason,
  };
}
