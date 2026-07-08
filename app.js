import { App } from "@slack/bolt";
import { ChromaClient } from "chromadb";
import OpenAI from "openai";

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
});

const openai = new OpenAI();
const chroma = new ChromaClient();

app.event("app_mention", async ({ event, say }) => {
  const question = event.text.replace(/<@[^>]+>/, "").trim();

  // 1. Embed the question
  const qEmbedding = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: question,
  });

  // 2. Retrieve top chunks
  const collection = await chroma.getOrCreateCollection({ name: "docs" });
  const results = await collection.query({
    queryEmbeddings: [qEmbedding.data[0].embedding],
    nResults: 4,
  });

  const context = results.documents[0].join("\n---\n");
  const topScore = results.distances[0][0]; // lower = more similar (Chroma default = L2)

  // 3. Generate answer
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: `Answer only using the provided context. If the context doesn't contain the answer, say "I don't have documentation on that."\n\nContext:\n${context}`,
      },
      { role: "user", content: question },
    ],
  });

  const answer = completion.choices[0].message.content;

  // 4. CRITICAL — log for Phase 2 later
  console.log(JSON.stringify({
    question,
    topScore,
    answer,
    timestamp: new Date().toISOString(),
  }));
  // (swap this for an actual DB insert once you're past prototyping)

  await say(`${answer}\n\n_Sources: ${results.metadatas[0].map(m => m.source).join(", ")}_`);
});

app.start();
console.log("⚡️ Bot running");
