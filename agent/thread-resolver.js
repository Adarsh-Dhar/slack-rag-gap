import { OpenAI } from 'openai';
import { updateUsageLedger } from './usage-ledger.js';

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

const VALID_LABELS = new Set(['resolved', 'follow-up-question', 'correction']);
const SAFE_DEFAULT = { label: 'resolved', correctedText: null, correctedSources: [] };

/**
 * Analyzes Slack thread replies to classify whether the bot's answer was
 * sufficient, prompted a follow-up question, or received an explicit correction.
 *
 * @param {string} question - Original question text
 * @param {string[]} sources - Source filenames cited in the bot answer
 * @param {{user: string, text: string}[]} replies - Thread replies after the bot's message
 * @param {string|null} [answerText] - The bot's actual answer text (improves correction detection)
 * @returns {Promise<{label: string, correctedText: string|null, correctedSources: string[]}>}
 */
export async function judgeFollowUp(question, sources, replies, answerText = null, ledgerPath = undefined) {
  // Fast path: no replies means nothing to judge
  if (replies.length === 0) {
    return { label: 'resolved', correctedText: null, correctedSources: [] };
  }

  const transcript = replies.map((r, i) => `[${i}] ${r.text}`).join('\n');

  let parsed;
  try {
    const res = await openai.chat.completions.create({
      model: CHAT_MODEL,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            'You analyze a Slack thread reply to decide whether it indicates the bot\'s answer\n' +
            'was sufficient, asks a follow-up question, or explicitly corrects wrong information.\n' +
            'A correction is ANY reply that disputes, contradicts, or updates specific facts in the bot\'s answer.\n' +
            'Respond only with JSON:\n' +
            '{\n' +
            '  "label": "resolved" | "follow-up-question" | "correction",\n' +
            '  "corrected_text": string or null (the human\'s correction text, if label is correction),\n' +
            '  "corrected_sources": string[] (filenames of docs the correction implicates, may be empty)\n' +
            '}',
        },
        {
          role: 'user',
          content:
            `Original question: ${question}\n` +
            `Documents cited: ${sources.join(', ')}\n` +
            (answerText ? `Bot's answer: ${answerText}\n` : '') +
            `Replies:\n${transcript}`,
        },
      ],
    });

    parsed = JSON.parse(res.choices[0].message.content);
  } catch (err) {
    console.error('judgeFollowUp: LLM call or JSON parse failed:', err.message);
    return { ...SAFE_DEFAULT };
  }

  const label = parsed.label;

  if (!VALID_LABELS.has(label)) {
    console.error(`judgeFollowUp: invalid label "${label}"; returning safe default`);
    return { ...SAFE_DEFAULT };
  }

  const correctedSources = parsed.corrected_sources ?? [];
  const correctedText = parsed.corrected_text ?? null;

  // Update usage ledger based on label
  try {
    if (label === 'follow-up-question') {
      updateUsageLedger(sources, 'followUpCount', ledgerPath);
    } else if (label === 'correction') {
      const targets = correctedSources.length > 0 ? correctedSources : sources;
      updateUsageLedger(targets, 'correctionCount', ledgerPath);
    }
  } catch (err) {
    console.error('judgeFollowUp: ledger update failed:', err.message);
  }

  return { label, correctedText, correctedSources };
}
