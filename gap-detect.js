import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { OpenAI } from 'openai';

// Same client/model as agent/rag.js and ingest.js — reuse, don't reinvent.
const openai = new OpenAI({
  apiKey: process.env.GITHUB_TOKEN,
  baseURL: 'https://models.github.ai/inference',
});

const EMBEDDING_MODEL = 'openai/text-embedding-3-small';
const LOG_PATH = path.join(process.cwd(), 'query-log.jsonl');
const GAPS_PATH = path.join(process.cwd(), 'gaps.json');

// Tune these two by eye once you have real data.
const SIMILARITY_THRESHOLD = 0.83; // cosine similarity to join an existing cluster
const HALF_LIFE_DAYS = 7; // a hit from 7 days ago counts half as much as one today

function cosineSimilarity(a, b) {
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

function recencyWeight(timestamp) {
  const ageDays = (Date.now() - new Date(timestamp).getTime()) / (1000 * 60 * 60 * 24);
  return 0.5 ** (ageDays / HALF_LIFE_DAYS);
}

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

async function embed(text) {
  const res = await openai.embeddings.create({ model: EMBEDDING_MODEL, input: text });
  return res.data[0].embedding;
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
      bestCluster.members.push({ question: entry.question, timestamp: entry.timestamp });
      // Running mean, so the centroid stays the average of every member seen so far.
      const n = bestCluster.members.length;
      bestCluster.centroid = bestCluster.centroid.map((v, i) => (v * (n - 1) + embedding[i]) / n);
    } else {
      clusters.push({
        centroid: embedding,
        members: [{ question: entry.question, timestamp: entry.timestamp }],
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
}

main();