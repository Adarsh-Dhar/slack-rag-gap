import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import pdf from 'pdf-parse';
import { ChromaClient } from 'chromadb';
import { OpenAI } from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const chroma = new ChromaClient();
const DOCS_DIR = path.join(process.cwd(), 'docs');

function chunkText(text, size = 1000) {
  return text.match(new RegExp(`.{1,${size}}`, 'gs')) || [];
}

async function ingestFile(filePath) {
  const buffer = fs.readFileSync(filePath);
  const { text } = await pdf(buffer);
  const chunks = chunkText(text);

  const collection = await chroma.getOrCreateCollection({ name: 'docs' });
  const fileName = path.basename(filePath);

  for (const [i, chunk] of chunks.entries()) {
    const embedding = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: chunk,
    });
    await collection.add({
      ids: [`${fileName}-${i}`],
      embeddings: [embedding.data[0].embedding],
      documents: [chunk],
      metadatas: [{ source: fileName }],
    });
  }
  console.log(`Ingested ${chunks.length} chunks from ${fileName}`);
}

async function main() {
  if (!fs.existsSync(DOCS_DIR)) {
    console.error(`No docs/ folder found at ${DOCS_DIR}. Create it and add PDFs to ingest.`);
    process.exit(1);
  }

  const files = fs.readdirSync(DOCS_DIR).filter((f) => f.toLowerCase().endsWith('.pdf'));

  if (files.length === 0) {
    console.error(`No PDFs found in ${DOCS_DIR}. Add at least one .pdf file and rerun.`);
    process.exit(1);
  }

  for (const file of files) {
    await ingestFile(path.join(DOCS_DIR, file));
  }
}

main();
