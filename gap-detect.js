import 'dotenv/config';
import { randomUUID } from 'crypto';
import { WebClient } from '@slack/web-api';
import fs from 'fs';
import path from 'path';
import { draftStub, slugify } from './agent/draft-generator.js';
import { embed, recencyWeight } from './agent/embeddings.js';
import { recordFailure } from './agent/failure-counter.js';
import { findNearestCluster, listClusters, resetClusters, upsertCluster } from './agent/gap-store.js';
import log from './agent/logger.js';
import { notifyStakeholder, pingForExplanation } from './agent/notify-stakeholder.js';
import { recordResolution, resolveOwner } from './agent/sme-router.js';
import { withFileLockSync, writeJSONAtomic } from './agent/store.js';
import { judgeResolution } from './agent/thread-resolver.js';

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

const LOG_PATH = path.join(process.cwd(), 'query-log.jsonl');
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
 * Checks whether a cluster's representative question overlaps with any
 * already-resolved gap slug. Uses token overlap so that a draft titled
 * "wifi password information" (slug: "wifi-password-information") matches
 * a cluster question like "@bot what's the wifi password" even though
 * their raw slugs differ.
 *
 * @param {string} representative - cluster's representative question text
 * @param {Set<string>} resolvedSlugs
 * @returns {boolean}
 */
function clusterMatchesResolvedSlug(representative, resolvedSlugs) {
  if (resolvedSlugs.size === 0) return false;

  // Strip Slack @mentions before slugifying
  const cleanText = representative.replace(/<@[A-Z0-9]+>\s*/g, '').trim();
  const slug = slugify(cleanText);
  const questionTokens = new Set(slug.split('-').filter((t) => t.length > 2));
  if (questionTokens.size === 0) return false;

  for (const resolved of resolvedSlugs) {
    const resolvedTokens = new Set(resolved.split('-').filter((t) => t.length > 2));
    if (resolvedTokens.size === 0) continue;

    let overlap = 0;
    for (const t of resolvedTokens) {
      if (questionTokens.has(t)) overlap++;
    }
    // Match if ≥50 % of the resolved-slug tokens appear in the question
    if (overlap / resolvedTokens.size >= 0.5) return true;
  }
  return false;
}

/**
 * Single-pass clustering: for each question, join the most similar
 * existing cluster if it's above threshold, else start a new one. Order-
 * dependent and doesn't re-merge clusters after the fact — fine for MVP,
 * revisit if clusters start looking wrong once you have more data.
 *
 * Clusters live in the `gap-clusters` Chroma collection instead of an
 * in-memory array. gap-detect.js still rebuilds from the full
 * query-log.jsonl on every run (loadUnansweredQueries reads the whole
 * file each time), so the collection is wiped first — but the per-question
 * nearest-cluster lookup is now a Chroma ANN `.query()` call instead of a
 * loop computing cosineSimilarity() against every cluster seen so far.
 */
async function clusterQuestions(queries) {
  const collection = await resetClusters();

  for (const entry of queries) {
    const embedding = await embed(entry.question);

    const newMember = {
      question: entry.question,
      timestamp: entry.timestamp,
      channel: entry.channel,
      thread_ts: entry.thread_ts,
    };

    const nearest = await findNearestCluster(collection, embedding);

    if (nearest && nearest.similarity >= SIMILARITY_THRESHOLD) {
      const members = JSON.parse(nearest.metadata.membersJson);
      members.push(newMember);

      // Running mean, so the centroid stays the average of every member seen so far.
      const n = members.length;
      const centroid = nearest.centroidEmbedding.map((v, i) => (v * (n - 1) + embedding[i]) / n);

      await upsertCluster(collection, nearest.id, centroid, {
        representative: members[0].question,
        membersJson: JSON.stringify(members),
        hitCount: members.length,
        lastSeen: newMember.timestamp,
        channel: newMember.channel ?? '',
      });
    } else {
      await upsertCluster(collection, `cluster-${randomUUID()}`, embedding, {
        representative: newMember.question,
        membersJson: JSON.stringify([newMember]),
        hitCount: 1,
        lastSeen: newMember.timestamp,
        channel: newMember.channel ?? '',
      });
    }
  }

  return listClusters(collection);
}

/**
 * @param {{id: string, embedding: number[]|null, metadata: object}[]} clusters - as returned by listClusters()
 */
function rankClusters(clusters) {
  return clusters
    .map((cluster) => {
      const members = JSON.parse(cluster.metadata.membersJson);
      return {
        representative: cluster.metadata.representative,
        hitCount: members.length,
        score: members.reduce((sum, m) => sum + recencyWeight(m.timestamp), 0),
        lastSeen: members
          .map((m) => m.timestamp)
          .sort()
          .at(-1),
        members,
      };
    })
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
  // Early exit: skip clusters whose representative question overlaps with
  // an already-resolved gap slug. Without this, the unresolved-ping path
  // below fires every scheduler cycle for gaps that already have a draft.
  if (clusterMatchesResolvedSlug(cluster.representative, resolvedSlugs)) {
    log.debug(
      { module: 'gap-detect', cluster: cluster.representative },
      'Skipping cluster — matches an already-resolved gap slug',
    );
    return;
  }

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
      log.debug({ module: 'gap-detect', slug: draft.slug }, 'Skipping already-resolved gap');
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
    log.debug({ module: 'gap-detect' }, 'No unanswered queries in query-log.jsonl');
    return;
  }

  log.debug({ module: 'gap-detect', queryCount: queries.length }, 'Clustering unanswered queries');

  const clusters = await clusterQuestions(queries);
  const ranked = rankClusters(clusters);

  log.debug(
    { module: 'gap-detect', clusterCount: ranked.length, collection: 'gap-clusters' },
    'Wrote gap clusters to Chroma',
  );
  for (const gap of ranked.slice(0, 10)) {
    log.debug(
      {
        module: 'gap-detect',
        hitCount: gap.hitCount,
        score: Number(gap.score.toFixed(2)),
        cluster: gap.representative,
      },
      'Top gap',
    );
  }

  log.debug({ module: 'gap-detect' }, 'Checking top gaps for resolved threads worth drafting');
  const resolvedSlugs = loadResolvedSlugs();

  // Single auth.test() call — reused by every tryDraftFromCluster invocation
  let botUserId;
  try {
    const authInfo = await slack.auth.test();
    botUserId = authInfo.user_id;
    log.debug({ module: 'gap-detect', user: authInfo.user, team: authInfo.team }, 'Bot auth verified');
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
