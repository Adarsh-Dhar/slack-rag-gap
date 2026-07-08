import fs from "fs";
import pdf from "pdf-parse";
import { ChromaClient } from "chromadb";
import OpenAI from "openai";

const openai = new OpenAI();
const chroma = new ChromaClient();

async function ingest(filePath) {
  const buffer = fs.readFileSync(filePath);
  const { text } = await pdf(buffer);

  // naive chunking: 1000 chars per chunk
  const chunks = text.match(/.{1,1000}/gs) || [];

  const collection = await chroma.getOrCreateCollection({ name: "docs" });

  for (const [i, chunk] of chunks.entries()) {
    const embedding = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: chunk,
    });
    await collection.add({
      ids: [`${filePath}-${i}`],
      embeddings: [embedding.data[0].embedding],
      documents: [chunk],
      metadatas: [{ source: filePath }],
    });
  }
  console.log(`Ingested ${chunks.length} chunks from ${filePath}`);
}

ingest("./docs/handbook.pdf");
