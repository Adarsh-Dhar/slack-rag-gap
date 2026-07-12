import fs from 'node:fs';
import path from 'node:path';
import { checkOwnerLiveness } from './doc-owners.js';
import { cosineSimilarity, embed } from './embeddings.js';
import { isRetryableLLMError, withRetry } from './with-retry.js';

const PROCESS_OWNERS_PATH = path.join(process.cwd(), 'process-owners.json');
const DOC_OWNERS_PATH = path.join(process.cwd(), 'doc-owners.json');

// Cache for doc-owner tag embeddings to avoid re-embedding on every call
let tagEmbeddingCache = null;
let docOwnersFileMtime = null;

// Lower than sme-router.js's 0.78 (question-vs-question) because we're
// comparing a full question embedding against a short tag-string embedding.
// Empirically: correct matches land 0.52-0.74, unrelated queries 0.04-0.15.
const DOC_OWNER_SIMILARITY_THRESHOLD = 0.45;

function loadJson(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  delete data._comment;
  return data;
}

/**
 * Invalidates the tag embedding cache if doc-owners.json has been modified.
 * Called at the start of matchDocOwner to ensure cache freshness.
 */
function invalidateCacheIfNeeded() {
  if (!fs.existsSync(DOC_OWNERS_PATH)) {
    tagEmbeddingCache = null;
    docOwnersFileMtime = null;
    return;
  }

  const currentMtime = fs.statSync(DOC_OWNERS_PATH).mtimeMs;
  if (docOwnersFileMtime === null || currentMtime !== docOwnersFileMtime) {
    tagEmbeddingCache = null;
    docOwnersFileMtime = currentMtime;
  }
}

/**
 * Builds the tag embedding cache by embedding all doc topic_tags once.
 * Returns a Map of docPath -> embedding.
 */
async function buildTagEmbeddingCache(docs) {
  const cache = new Map();
  for (const [docPath, { topic_tags }] of Object.entries(docs)) {
    const tags = (topic_tags || []).join(', ');
    if (tags.trim()) {
      const embedding = await withRetry(async () => await embed(tags), {
        retries: 3,
        baseDelayMs: 500,
        isRetryable: isRetryableLLMError,
        label: 'buildTagEmbeddingCache',
      });
      cache.set(docPath, embedding);
    }
  }
  return cache;
}

/**
 * Highest-confidence signal: a human explicitly tagged someone as the owner
 * of this topic. Matched by simple case-insensitive keyword containment —
 * no embedding call needed, and it keeps the config file human-editable
 * without needing to regenerate embeddings whenever it changes.
 *
 * @param {string} question
 * @returns {Promise<{userId: string, reason: string}|null>}
 */
export async function matchProcessOwner(question) {
  const owners = loadJson(PROCESS_OWNERS_PATH);
  const lowerQuestion = question.toLowerCase();

  for (const [topic, { owner, keywords }] of Object.entries(owners)) {
    const hit = (keywords || []).find((kw) => lowerQuestion.includes(kw.toLowerCase()));
    if (hit) {
      const alive = await checkOwnerLiveness(owner);
      if (!alive) continue; // skip a departed tagged owner, let other signals win
      return { userId: owner, reason: `tagged process owner (${topic}, matched "${hit}")` };
    }
  }

  return null;
}

/**
 * Finds the doc whose topic_tags are the closest semantic match to this
 * gap's embedding, and returns its owner — i.e. "who owns the doc space
 * this question would live in", even if they've never personally answered
 * a similar question before.
 *
 * @param {number[]} embedding
 * @returns {Promise<{userId: string, reason: string}|null>}
 */
export async function matchDocOwner(embedding) {
  invalidateCacheIfNeeded();

  const docs = loadJson(DOC_OWNERS_PATH);
  const entries = Object.entries(docs);
  if (entries.length === 0) return null;

  // Build cache if not exists or was invalidated
  if (!tagEmbeddingCache) {
    tagEmbeddingCache = await buildTagEmbeddingCache(docs);
  }

  let best = null;
  for (const [docPath, { owner }] of entries) {
    const tagEmbedding = tagEmbeddingCache.get(docPath);
    if (!tagEmbedding) continue; // Skip docs with no tags

    const similarity = cosineSimilarity(embedding, tagEmbedding);
    if (similarity >= DOC_OWNER_SIMILARITY_THRESHOLD && (!best || similarity > best.similarity)) {
      best = { userId: owner, docPath, similarity };
    }
  }

  if (!best) return null;
  return {
    userId: best.userId,
    reason: `doc-space owner (${best.docPath}, similarity=${best.similarity.toFixed(2)})`,
  };
}
