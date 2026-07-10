import fs from 'fs';
import path from 'path';
import { cosineSimilarity, recencyWeight } from './embeddings.js';
import { readJSON, withFileLockSync, writeJSONAtomic } from './store.js';
import { matchDocOwner, matchProcessOwner } from './topic-owner.js';

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
  withFileLockSync(HISTORY_PATH, () => {
    const history = readJSON(HISTORY_PATH, []);
    history.push({ embedding, userId, timestamp: new Date().toISOString() });
    writeJSONAtomic(HISTORY_PATH, history);
  });
}

// Fixed weight given to a tagged-process-owner match. It's a human saying
// "this person owns this topic," so it should outrank any amount of
// historical-resolver or doc-owner similarity, not just nudge the tally.
const PROCESS_OWNER_WEIGHT = 100;

// Doc-owner matches are scaled up relative to raw cosine similarity so a
// confident doc match (e.g. 0.9) reliably beats a handful of so-so
// historical resolutions, without being un-overridable like a tagged owner.
const DOC_OWNER_WEIGHT_MULTIPLIER = 10;

function historicalResolverWeights(embedding) {
  const history = loadHistory();
  if (history.length === 0) return [];

  const scored = history
    .map((entry) => ({ ...entry, similarity: cosineSimilarity(embedding, entry.embedding) }))
    .filter((entry) => entry.similarity >= SIMILARITY_THRESHOLD)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, TOP_N);

  return scored.map((entry) => ({
    userId: entry.userId,
    weight: entry.similarity * recencyWeight(entry.timestamp),
    source: 'historical resolver',
  }));
}

/**
 * Given a new gap's representative question (and its embedding), decides
 * who to route the draft to by combining three signals:
 *
 *   1. Tagged process owner (process-owners.json) — highest confidence,
 *      human-curated, wins outright when it fires.
 *   2. Doc-space owner (doc-owners.json) — whoever owns the doc this
 *      question is semantically closest to.
 *   3. Historical resolver (sme-history.json) — who's answered similar
 *      questions before, weighted by similarity and recency.
 *
 * Falls back to STAKEHOLDER_USER_ID only if none of the three signals fire
 * (e.g. a brand-new topic with no tag, no owned doc, and no history).
 *
 * @param {number[]} embedding
 * @param {string} questionText
 * @returns {Promise<{userId: string|null, reason: string}>}
 */
export async function resolveOwner(embedding, questionText) {
  const votes = [];

  const processOwnerMatch = matchProcessOwner(questionText);
  if (processOwnerMatch) {
    votes.push({ userId: processOwnerMatch.userId, weight: PROCESS_OWNER_WEIGHT, source: processOwnerMatch.reason });
  }

  const docOwnerMatch = await matchDocOwner(embedding);
  if (docOwnerMatch) {
    votes.push({
      userId: docOwnerMatch.userId,
      weight: docOwnerMatch.similarity
        ? docOwnerMatch.similarity * DOC_OWNER_WEIGHT_MULTIPLIER
        : DOC_OWNER_WEIGHT_MULTIPLIER,
      source: docOwnerMatch.reason,
    });
  }

  votes.push(...historicalResolverWeights(embedding));

  if (votes.length === 0) return fallback('no tag, doc-owner, or resolution history match');

  const tally = new Map();
  const reasonsByUser = new Map();
  for (const vote of votes) {
    tally.set(vote.userId, (tally.get(vote.userId) || 0) + vote.weight);
    const reasons = reasonsByUser.get(vote.userId) || new Set();
    reasons.add(vote.source);
    reasonsByUser.set(vote.userId, reasons);
  }

  const [bestUser, bestScore] = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
  const reasons = [...reasonsByUser.get(bestUser)].join(' + ');
  return { userId: bestUser, reason: `${reasons} (score=${bestScore.toFixed(2)})` };
}
