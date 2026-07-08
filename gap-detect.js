import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { WebClient } from '@slack/web-api';
import { judgeResolution } from './agent/thread-resolver.js';
import { draftStub } from './agent/draft-generator.js';
import { notifyStakeholder } from './agent/notify-stakeholder.js';
import { embed, cosineSimilarity, recencyWeight } from './agent/embeddings.js';
import { resolveOwner, recordResolution } from './agent/sme-router.js';

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

const LOG_PATH = path.join(process.cwd(), 'query-log.jsonl');
const GAPS_PATH = path.join(process.cwd(), 'gaps.json');

// Only chase drafts for clusters that look like real, recurring gaps —
// a single one-off odd question isn't worth bothering a stakeholder over.
const MIN_HITS_FOR_DRAFT = 1;
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
  const set = loadResolvedSlugs();
  set.add(slug);
  fs.writeFileSync(RESOLVED_GAPS_PATH, JSON.stringify([...set], null, 2));
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
        members: [{
          question: entry.question,
          timestamp: entry.timestamp,
          channel: entry.channel,
          thread_ts: entry.thread_ts,
        }],
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
      lastSeen: cluster.members.map((m) => m.timestamp).sort().at(-1),
      members: cluster.members,
    }))
    .sort((a, b) => b.score - a.score);
}

/**
 * For a gap cluster, find the most recent member with a real thread_ts,
 * pull the replies that came after the bot's answer, and see if a human
 * resolved it. If so, draft a stub and notify the stakeholder.
 */
async function tryDraftFromCluster(cluster) {
  const withThread = cluster.members.filter((m) => m.channel && m.thread_ts);
  if (withThread.length === 0) return;

  const { channel, thread_ts } = withThread.at(-1);

  try {
    // Debug: Check bot's auth info and scopes
    try {
      const authInfo = await slack.auth.test();
      console.log(`  Bot user: ${authInfo.user}, Team: ${authInfo.team}`);
    } catch (error) {
      console.error(`  Auth test failed:`, error.message);
    }

    // Try using conversations.replies first
    let messages;
    try {
      const result = await slack.conversations.replies({ channel, ts: thread_ts });
      messages = result.messages;
    } catch (error) {
      if (error.data?.error === 'missing_scope') {
        console.error(`  conversations.replies failed with missing_scope, trying channels.history as fallback`);
        // Fallback: use channels.history with thread_ts to get thread messages
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

    const botUserId = (await slack.auth.test()).user_id;
    const replies = messages
      .filter((m) => m.user && m.user !== botUserId && m.ts !== thread_ts)
      .map((m) => ({ user: m.user, text: m.text }));

    const { resolved, resolvingText, resolvingUser } = await judgeResolution(cluster.representative, replies);
    if (!resolved) return;

    // One embedding call, reused both to route this draft to the right SME
    // and to record who resolved this topic for next time.
    const topicEmbedding = await embed(cluster.representative);

    const { permalink } = await slack.chat.getPermalink({ channel, message_ts: thread_ts });
    const draft = await draftStub({
      question: cluster.representative,
      resolvingText,
      permalink,
      hitCount: cluster.hitCount,
    });

    const { userId, reason } = await resolveOwner(topicEmbedding, cluster.representative);
    await notifyStakeholder(slack, { ...draft, permalink }, userId, reason);
    markResolved(draft.slug);

    // Learn from this resolution regardless of who it got routed to, so the
    // router improves over time even before any draft is approved.
    recordResolution(topicEmbedding, resolvingUser);
  } catch (error) {
    console.error(`  Error processing cluster "${cluster.representative}":`, error.message);
    if (error.data?.error === 'missing_scope') {
      console.error(`  Missing scope details:`, error.data);
      console.error(`  Channel: ${channel}, Thread: ${thread_ts}`);
    }
  }
}

async function main() {
  const queries = loadUnansweredQueries();

  if (queries.length === 0) {
    console.log('No unanswered queries found in query-log.jsonl — nothing to cluster yet.');
    return;
  }

  console.log(`Clustering ${queries.length} unanswered quer${queries.length === 1 ? 'y' : 'ies'}...`);

  const clusters = await clusterQuestions(queries);
  const ranked = rankClusters(clusters);

  fs.writeFileSync(GAPS_PATH, JSON.stringify(ranked, null, 2));

  console.log(`\nWrote ${ranked.length} gap cluster(s) to ${GAPS_PATH}\n`);
  console.log('Top gaps:');
  for (const gap of ranked.slice(0, 10)) {
    console.log(`  [${gap.hitCount}x, score=${gap.score.toFixed(2)}] ${gap.representative}`);
  }

  console.log('\nChecking top gaps for resolved threads worth drafting...');
  const resolvedSlugs = loadResolvedSlugs();
  for (const cluster of ranked.slice(0, 10)) {
    if (cluster.hitCount < MIN_HITS_FOR_DRAFT) continue;
    try {
      await tryDraftFromCluster(cluster);
    } catch (e) {
      console.error(`  Failed to process cluster "${cluster.representative}": ${e}`);
    }
  }
}

main();