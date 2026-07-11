import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { ChromaClient } from 'chromadb';
import { getOpenAI } from './agent/openai-client.js';
import log from './agent/logger.js';

const chromaUrl = (process.env.CHROMA_URL ?? 'http://127.0.0.1:8000').replace('localhost', '127.0.0.1');
const chromaHost = new URL(chromaUrl);
const chroma = new ChromaClient({
  host: chromaHost.hostname,
  port: parseInt(chromaUrl.split(':').pop()) || 8000,
  ssl: chromaHost.protocol === 'https:',
  auth: undefined,
});

const COLLECTION_NAME = 'docs';
const EMBEDDING_MODEL = 'openai/text-embedding-3-small';
const DOCS_DIR = path.join(process.cwd(), 'docs');
const CHUNK_SIZE = 500;
const CHUNK_OVERLAP = 100;

// Chroma's default embedding function is not needed since we provide our own
const noopEmbeddingFunction = {
  generate: async () => {
    throw new Error('Embeddings should be provided manually');
  },
};

/**
 * Splits text into overlapping chunks by paragraph, then by sentence if needed.
 */
function chunkText(text, maxTokens = CHUNK_SIZE) {
  const paragraphs = text.split(/\n\n+/);
  const chunks = [];
  let current = '';

  for (const para of paragraphs) {
    if ((current + '\n\n' + para).length > maxTokens * 4) {
      // Rough token estimate: ~4 chars per token
      if (current) chunks.push(current.trim());
      current = para;
    } else {
      current = current ? current + '\n\n' + para : para;
    }
  }
  if (current.trim()) chunks.push(current.trim());

  // Apply overlap
  if (chunks.length <= 1) return chunks;
  const overlapped = [chunks[0]];
  for (let i = 1; i < chunks.length; i++) {
    const prev = chunks[i - 1];
    const overlap = prev.slice(-CHUNK_OVERLAP * 4); // ~4 chars per token
    overlapped.push(overlap + '\n\n' + chunks[i]);
  }
  return overlapped;
}

async function ingest() {
  log.info({ module: 'ingest', docsDir: DOCS_DIR }, 'Starting ingestion');

  const collection = await chroma.getOrCreateCollection({
    name: COLLECTION_NAME,
    embeddingFunction: noopEmbeddingFunction,
  });

  // Clear existing docs for a fresh ingest
  try {
    await chroma.deleteCollection({ name: COLLECTION_NAME });
  } catch {}
  const freshCollection = await chroma.getOrCreateCollection({
    name: COLLECTION_NAME,
    embeddingFunction: noopEmbeddingFunction,
  });

  const files = fs.readdirSync(DOCS_DIR).filter((f) => f.endsWith('.md'));
  let totalChunks = 0;

  for (const file of files) {
    const filePath = path.join(DOCS_DIR, file);
    const raw = fs.readFileSync(filePath, 'utf-8');

    // Strip frontmatter if present
    const content = raw.replace(/^---[\s\S]*?---\n*/, '');
    const chunks = chunkText(content);

    log.info({ module: 'ingest', file, chunks: chunks.length }, 'Ingesting file');

    // Embed all chunks in batch
    const res = await getOpenAI().embeddings.create({
      model: EMBEDDING_MODEL,
      input: chunks,
    });

    const ids = chunks.map((_, i) => `${file}-${i}`);
    const embeddings = res.data.map((d) => d.embedding);
    const metadatas = chunks.map((chunk, i) => ({
      source: file,
      chunkIndex: i,
      totalChunks: chunks.length,
    }));

    await freshCollection.add({
      ids,
      embeddings,
      documents: chunks,
      metadatas,
    });

    totalChunks += chunks.length;
    log.info({ module: 'ingest', file, chunks: chunks.length }, 'File ingested');
  }

  log.info({ module: 'ingest', totalFiles: files.length, totalChunks }, 'Ingestion complete');
}

ingest().catch((err) => {
  log.error({ module: 'ingest', err: err.message }, 'Ingestion failed');
  process.exit(1);
});
