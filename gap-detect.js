import 'dotenv/config';
import { WebClient } from '@slack/web-api';
import fs from 'fs';
import path from 'path';
import { draftStub } from './agent/draft-generator.js';
import { cosineSimilarity, embed, recencyWeight } from './agent/embeddings.js';
import { recordFailure } from './agent/failure-counter.js';
import log from './agent/logger.js';
import { notifyStakeholder, pingForExplanation } from './agent/notify-stakeholder.js';
import { recordResolution, resolveOwner } from './agent/sme-router.js';
import { readJSON, withFileLockSync, writeJSONAtomic } from './agent/store.js';
import { judgeResolution } from './agent/thread-resolver.js';

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

const LOG_PATH = path.join(process.cwd(), 'query-log.jsonl');
const GAPS_PATH = path.join(process.cwd(), 'gaps.json');
const FAILED_DRAFTS_PATH = path.join(process.cwd(), 'failed-drafts.json');
const MAX_CONSECUTIVE_FAILURES = parseInt(process.env.MAX_CONSECUTIVE_FAILURES) || 5;

// Only chase drafts for clusters that look like real, recurring gaps —
// a single one-off odd question isn't worth bothering a stakeholder over.
const MIN_HITS_FOR_DRAFT = parseInt(process.env.MIN_HITS_FOR_DRAFT) || 3;
const RESOLVED_GAPS_PATH = path.join(process.cwd(), 'resolved-gaps.json');

// Tune by eye once you have real data.
const SIMILARITY_THRESHOLD = 0.83; // cosine similarity to join an existing cluster

/**
 * Only lines logged by retrieveContext() (agent/rag.js) with hasResults === false.
 * This skips the separate 'answer' log entries written by logAnswer(), which
 * don't have a hasResults field at all.
 */
function loadUnansweredQueries() {
  if (!fs.existsSync(LOG_PATH)) return [];
  const lines = fs.readFileSync(LOG_PATH, 'utf-8').trim().split('\n').filter(Boolean);
  return lines.map((line) => JSON.parse(line)).filter((entry) => entry.hasResults === false);
}

function loadResolvedSlugs() {
  if (!fs.existsSync(RESOLVED_GAPS_PATH)) return new Set();
  return new Set(JSON.parse(fs.readFileSync(RESOLVED_GAPS_PATH, 'utf-8')));
}

function markResolved(slug) {
  withFileLockSync(RESOLVED_GAPS_PATH, () => {
    const fresh = loadResolvedSlugs();
    fresh.add(slug);
    writeJSONAtomic(RESOLVED_GAPS_PATH, [...fresh]);
  });
}

/**
 * Greedy single-pass clustering: for each question, join the most similar
 * existing cluster if it's above threshold, else start a new one. Order-
 * dependent and doesn't re-merge clusters after the fact — fine for MVP,
 * revisit if clusters start looking wrong once you have more data.
 */
async function clusterQuestions(queries) {
  const clusters = []; // { centroid: number[], members: {question, timestamp}[] }

  for (const entry of queries) {
    const embedding = await embed(entry.question);

    let bestCluster = null;
    let bestScore = -1;
    for (const cluster of clusters) {
      const score = cosineSimilarity(embedding, cluster.centroid);
      if (score > bestScore) {
        bestScore = score;
        bestCluster = cluster;
      }
    }

    if (bestCluster && bestScore >= SIMILARITY_THRESHOLD) {
      bestCluster.members.push({
        question: entry.question,
        timestamp: entry.timestamp,
        channel: entry.channel,
        thread_ts: entry.thread_ts,
      });
      // Running mean, so the centroid stays the average of every member seen so far.
      const n = bestCluster.members.length;
      bestCluster.centroid = bestCluster.centroid.map((v, i) => (v * (n - 1) + embedding[i]) / n);
    } else {
      clusters.push({
        centroid: embedding,
        members: [
          {
            question: entry.question,
            timestamp: entry.timestamp,
            channel: entry.channel,
            thread_ts: entry.thread_ts,
          },
        ],
      });
    }
  }

  return clusters;
}

function rankClusters(clusters) {
  return clusters
    .map((cluster) => ({
      representative: cluster.members[0].question,
      hitCount: cluster.members.length,
      score: cluster.members.reduce((sum, m) => sum + recencyWeight(m.timestamp), 0),
      lastSeen: cluster.members
        .map((m) => m.timestamp)
        .sort()
        .at(-1),
      members: cluster.members,
    }))
    .sort((a, b) => b.score - a.score);
}

/**
 * For a gap cluster, find the most recent member with a real thread_ts,
 * pull the replies that came after the bot's answer, and see if a human
 * resolved it. If so, draft a stub and notify the stakeholder.
 *
 * @param {import('./gap-detect.js').RankedCluster} cluster
 * @param {Set<string>} resolvedSlugs - already-resolved draft slugs (checked after LLM titles the draft)
 * @param {string} botUserId - cached bot user ID from a single auth.test() call
 */
async function tryDraftFromCluster(cluster, resolvedSlugs, botUserId) {
  const withThread = cluster.members.filter((m) => m.channel && m.thread_ts);
  if (withThread.length === 0) return;

  const { channel, thread_ts } = withThread.at(-1);

  try {
    let messages;
    try {
      const result = await slack.conversations.replies({ channel, ts: thread_ts });
      messages = result.messages;
    } catch (error) {
      if (error.data?.error === 'missing_scope') {
        log.warn(
          { module: 'gap-detect', channel, thread_ts, err: error.data?.error },
          'conversations.replies missing_scope — falling back to conversations.history',
        );
        const historyResult = await slack.conversations.history({
          channel,
          oldest: thread_ts,
          inclusive: true,
        });
        messages = historyResult.messages;
      } else {
        throw error;
      }
    }

    const replies = messages
      .filter((m) => m.user && m.user !== botUserId && m.ts !== thread_ts)
      .map((m) => ({ user: m.user, text: m.text }));

    const { resolved, resolvingText, resolvingUser } = await judgeResolution(cluster.representative, replies);

    if (!resolved) {
      // Nobody has explained this yet, but the cluster is big enough to be
      // worth chasing — proactively ask, rather than waiting silently for
      // someone to volunteer. Re-runs each cycle will ping again as long as
      // it stays unresolved; there's no cooldown here by design.
      const topicEmbedding = await embed(cluster.representative);
      const { userId, reason } = await resolveOwner(topicEmbedding, cluster.representative);
      await pingForExplanation(
        slack,
        { question: cluster.representative, hitCount: cluster.hitCount, channel, thread_ts },
        userId,
        reason,
      );
      return;
    }

    const topicEmbedding = await embed(cluster.representative);

    const { permalink } = await slack.chat.getPermalink({ channel, message_ts: thread_ts });
    const draft = await draftStub({
      question: cluster.representative,
      resolvingText,
      permalink,
      hitCount: cluster.hitCount,
    });

    // Skip drafts whose slug matches an already-resolved gap
    if (resolvedSlugs.has(draft.slug)) {
      log.info({ module: 'gap-detect', slug: draft.slug }, 'Skipping already-resolved gap');
      return;
    }

    const { userId, reason } = await resolveOwner(topicEmbedding, cluster.representative);
    await notifyStakeholder(slack, { ...draft, permalink }, userId, reason);
    markResolved(draft.slug);

    recordResolution(topicEmbedding, resolvingUser);
  } catch (error) {
    log.error(
      { module: 'gap-detect', cluster: cluster.representative, err: error.message, channel, thread_ts },
      'Error processing cluster',
    );
    // Dead-letter: record the failure so we can distinguish transient blips
    // from persistent misconfigurations (e.g. GITHUB_TOKEN wrong for days).
    recordFailure(FAILED_DRAFTS_PATH, {
      cluster: cluster.representative,
      error: error.message,
      channel,
      thread_ts,
      missingScope: error.data?.error === 'missing_scope',
      lastAttemptAt: new Date().toISOString(),
    });
    if (error.data?.error === 'missing_scope') {
      log.error({ module: 'gap-detect', errorData: error.data, channel, thread_ts }, 'Missing scope details');
    }
  }
}

export async function main() {
  const queries = loadUnansweredQueries();

  if (queries.length === 0) {
    log.info({ module: 'gap-detect' }, 'No unanswered queries in query-log.jsonl');
    return;
  }

  log.info({ module: 'gap-detect', queryCount: queries.length }, 'Clustering unanswered queries');

  const clusters = await clusterQuestions(queries);
  const ranked = rankClusters(clusters);

  writeJSONAtomic(GAPS_PATH, ranked);

  log.info({ module: 'gap-detect', clusterCount: ranked.length, path: GAPS_PATH }, 'Wrote gap clusters');
  for (const gap of ranked.slice(0, 10)) {
    log.info(
      {
        module: 'gap-detect',
        hitCount: gap.hitCount,
        score: Number(gap.score.toFixed(2)),
        cluster: gap.representative,
      },
      'Top gap',
    );
  }

  log.info({ module: 'gap-detect' }, 'Checking top gaps for resolved threads worth drafting');
  const resolvedSlugs = loadResolvedSlugs();

  // Single auth.test() call — reused by every tryDraftFromCluster invocation
  let botUserId;
  try {
    const authInfo = await slack.auth.test();
    botUserId = authInfo.user_id;
    log.info({ module: 'gap-detect', user: authInfo.user, team: authInfo.team }, 'Bot auth verified');
  } catch (error) {
    log.error({ module: 'gap-detect', err: error.message }, 'auth.test() failed — skipping draft checks');
    return;
  }

  for (const cluster of ranked.slice(0, 10)) {
    if (cluster.hitCount < MIN_HITS_FOR_DRAFT) continue;
    try {
      await tryDraftFromCluster(cluster, resolvedSlugs, botUserId);
    } catch (e) {
      log.error(
        { module: 'gap-detect', cluster: cluster.representative, err: String(e) },
        'Outer cluster processing failure',
      );
      recordFailure(FAILED_DRAFTS_PATH, {
        cluster: cluster.representative,
        error: String(e),
        lastAttemptAt: new Date().toISOString(),
      });
    }
  }
}

// Only run main() when this file is executed directly, not when imported by
// scheduler.js or tests.
const isMain =
  process.argv[1] && (process.argv[1].endsWith('/gap-detect.js') || process.argv[1].endsWith('\\gap-detect.js'));
if (isMain) main();
