import fs from 'fs';
import path from 'path';
import { cosineSimilarity, recencyWeight } from './embeddings.js';

const HISTORY_PATH = path.join(process.cwd(), 'sme-history.json');

// Looser than the gap-clustering threshold (0.83 in gap-detect.js) — for
// routing we just need "same general topic area", not "same specific
// question". Tune by eye once sme-history.json has real entries.
const SIMILARITY_THRESHOLD = 0.78;
const TOP_N = 5;

function loadHistory() {
  if (!fs.existsSync(HISTORY_PATH)) return [];
  return JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf-8'));
}

function fallback(reason) {
  const userId = process.env.STAKEHOLDER_USER_ID || null;
  return { userId, reason: `fallback (${reason})` };
}

/**
 * Records that `userId` was the one who resolved a thread whose topic is
 * represented by `embedding`. Called from gap-detect.js every time a human
 * reply resolves a gap cluster — independent of whether the resulting draft
 * later gets approved, since "who answered" is itself the signal.
 *
 * @param {number[]} embedding
 * @param {string} userId - Slack user ID of whoever gave the resolving reply
 */
export function recordResolution(embedding, userId) {
  if (!userId) return;
  const history = loadHistory();
  history.push({ embedding, userId, timestamp: new Date().toISOString() });
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2));
}

/**
 * Given the embedding of a new gap's representative question, finds who's
 * historically answered similar questions and returns them as the SME to
 * route the draft to. Falls back to STAKEHOLDER_USER_ID when there's no
 * relevant history yet (e.g. a brand-new topic).
 *
 * @param {number[]} embedding
 * @returns {{userId: string|null, reason: string}}
 */
export function resolveOwner(embedding) {
  const history = loadHistory();
  if (history.length === 0) return fallback('no resolution history yet');

  const scored = history
    .map((entry) => ({ ...entry, similarity: cosineSimilarity(embedding, entry.embedding) }))
    .filter((entry) => entry.similarity >= SIMILARITY_THRESHOLD)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, TOP_N);

  if (scored.length === 0) return fallback('no similar past resolutions');

  // Weight each past resolution by how similar it is to this topic AND how
  // recent it was, then tally by user — so someone who answered 3 similar
  // questions last week outranks someone who answered 1 similar question
  // six months ago.
  const tally = new Map();
  for (const entry of scored) {
    const weight = entry.similarity * recencyWeight(entry.timestamp);
    tally.set(entry.userId, (tally.get(entry.userId) || 0) + weight);
  }

  const [bestUser, bestScore] = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
  return {
    userId: bestUser,
    reason: `historical resolver — ${scored.length} similar past thread(s), score=${bestScore.toFixed(2)}`,
  };
}
