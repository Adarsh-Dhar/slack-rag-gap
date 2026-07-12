import { getOpenAI } from './openai-client.js';
import { isRetryableLLMError, withRetry } from './with-retry.js';

const CHAT_MODEL = 'openai/gpt-4o';

/**
 * Classifies a document into one of several doc_type categories based on
 * its title and body. Returns the classification and a brief rationale.
 *
 * Categories:
 *   - runbook: operational procedures, how-to guides, incident response
 *   - design: architecture decisions, design docs, RFCs
 *   - api: API reference, endpoint documentation, SDK usage
 *   - policy: company policies, compliance rules, standards
 *   - onboarding: getting started guides, new hire materials
 *   - reference: lookups, glossaries, configuration references
 *   - other: anything that doesn't fit the above
 *
 * @param {{ title: string, body: string }} input
 * @returns {Promise<{ doc_type: string, rationale: string }>}
 */
export async function classifyDoc({ title, body }) {
  // Truncate body to keep token usage reasonable — first 3000 chars is
  // typically enough for classification.
  const truncatedBody = body.length > 3000 ? `${body.slice(0, 3000)}\n...(truncated)` : body;

  const res = await withRetry(
    () =>
      getOpenAI().chat.completions.create({
        model: CHAT_MODEL,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content:
              'Classify this document into one of these categories: runbook, design, api, policy, onboarding, reference, other. ' +
              'Respond only with JSON: {"doc_type": string, "rationale": string}. ' +
              'rationale: one sentence explaining the classification.',
          },
          {
            role: 'user',
            content: `Title: ${title}\n\nBody:\n${truncatedBody}`,
          },
        ],
      }),
    { isRetryable: isRetryableLLMError, label: 'classifyDoc completion' },
  );

  return JSON.parse(res.choices[0].message.content);
}
