import fs from 'node:fs';
import path from 'node:path';
import { cosineSimilarity, recencyWeight } from './embeddings.js';
import { resolveBlameOwner } from './git-blame-owner.js';
import log from './logger.js';
import { getOnCallPerson } from './on-call.js';
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
 * Weight given to recent committers for files related to the question.
 * Lower than doc-owner weight but above raw historical resolver weight
 * — a recent committer is a strong signal but not as authoritative as
 * a human-tagged owner.
 */
const RECENT_COMMITTER_WEIGHT = 5;

/**
 * Tries to find the most recent git committer for files mentioned in
 * the question text. Uses code-extraction to pull file paths from the
 * question, then looks up git blame info via GitHub API.
 *
 * @param {string} questionText
 * @param {Record<string, { owner?: string, github?: string }>} docOwners
 * @returns {Promise<Array<{userId: string|null, weight: number, source: string}>>}
 */
export async function recentCommitterWeights(questionText, docOwners = {}) {
  try {
    const { extractFilePaths } = await import('./code-extraction.js');
    const filePaths = extractFilePaths(questionText);
    if (filePaths.length === 0) return [];

    const votes = [];
    for (const filePath of filePaths.slice(0, 3)) {
      // Limit to 3 files to avoid excessive API calls
      const blame = await resolveBlameOwner(filePath, docOwners);
      if (blame.userId) {
        votes.push({
          userId: blame.userId,
          weight: RECENT_COMMITTER_WEIGHT,
          source: blame.reason,
        });
      }
    }
    return votes;
  } catch (err) {
    log.debug({ module: 'sme-router', err: err.message }, 'recentCommitterWeights failed');
    return [];
  }
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

  const processOwnerMatch = await matchProcessOwner(questionText);
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

  // Try git-blame for files mentioned in the question
  try {
    votes.push(...(await recentCommitterWeights(questionText)));
  } catch {
    // Non-critical — continue without git-blame votes
  }

  if (votes.length === 0) {
    // Try on-call as final fallback before the default stakeholder
    const onCall = getOnCallPerson();
    if (onCall) {
      return { userId: onCall.userId, reason: onCall.reason };
    }
    return fallback('no tag, doc-owner, or resolution history match');
  }

  const tally = new Map();
  const reasonsByUser = new Map();
  for (const vote of votes) {
    tally.set(vote.userId, (tally.get(vote.userId) || 0) + vote.weight);
    const reasons = reasonsByUser.get(vote.userId) || new Set();
    reasons.add(vote.source);
    reasonsByUser.set(vote.userId, reasons);
  }

  const [bestUser, bestScore] = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];

  // UNASSIGNED guard: if the best candidate is a known unassigned
  // placeholder (e.g. "unassigned" string), skip to fallback
  if (!bestUser || bestUser === 'unassigned' || bestUser === 'UNASSIGNED') {
    const onCall = getOnCallPerson();
    if (onCall) {
      return { userId: onCall.userId, reason: `on-call fallback (best was unassigned)` };
    }
    return fallback('best candidate is unassigned');
  }

  const reasons = [...reasonsByUser.get(bestUser)].join(' + ');
  return { userId: bestUser, reason: `${reasons} (score=${bestScore.toFixed(2)})` };
}
