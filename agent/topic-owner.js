import fs from 'fs';
import path from 'path';
import { embed, cosineSimilarity } from './embeddings.js';

const PROCESS_OWNERS_PATH = path.join(process.cwd(), 'process-owners.json');
const DOC_OWNERS_PATH = path.join(process.cwd(), 'doc-owners.json');

// Doc-owner matches use the same "same general topic area" bar as
// sme-router.js's historical-resolver matching, not the tighter
// gap-clustering bar in gap-detect.js.
const DOC_OWNER_SIMILARITY_THRESHOLD = 0.78;

function loadJson(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  delete data._comment;
  return data;
}

/**
 * Highest-confidence signal: a human explicitly tagged someone as the owner
 * of this topic. Matched by simple case-insensitive keyword containment —
 * no embedding call needed, and it keeps the config file human-editable
 * without needing to regenerate embeddings whenever it changes.
 *
 * @param {string} question
 * @returns {{userId: string, reason: string}|null}
 */
export function matchProcessOwner(question) {
  const owners = loadJson(PROCESS_OWNERS_PATH);
  const lowerQuestion = question.toLowerCase();

  for (const [topic, { owner, keywords }] of Object.entries(owners)) {
    const hit = (keywords || []).find((kw) => lowerQuestion.includes(kw.toLowerCase()));
    if (hit) {
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
  const docs = loadJson(DOC_OWNERS_PATH);
  const entries = Object.entries(docs);
  if (entries.length === 0) return null;

  let best = null;
  for (const [docPath, { owner, topic_tags }] of entries) {
    const tagEmbedding = await embed((topic_tags || []).join(', '));
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
