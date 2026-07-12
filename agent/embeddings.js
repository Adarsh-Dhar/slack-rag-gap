import { getOpenAI } from './openai-client.js';
import { withRetry, isRetryableLLMError } from './with-retry.js';

// Same client/model as agent/rag.js, ingest.js, and gap-detect.js — one place
// so routing logic (sme-router.js) and gap clustering (gap-detect.js) don't
// drift out of sync.

export const EMBEDDING_MODEL = 'openai/text-embedding-3-small';

export async function embed(text) {
  return withRetry(
    async () => {
      const res = await getOpenAI().embeddings.create({ model: EMBEDDING_MODEL, input: text });
      return res.data[0].embedding;
    },
    { retries: 3, baseDelayMs: 500, isRetryable: isRetryableLLMError, label: 'embed' },
  );
}

export function cosineSimilarity(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * A hit from `halfLifeDays` ago counts half as much as one today.
 */
export function recencyWeight(timestamp, halfLifeDays = 7) {
  const ageDays = (Date.now() - new Date(timestamp).getTime()) / (1000 * 60 * 60 * 24);
  return 0.5 ** (ageDays / halfLifeDays);
}
