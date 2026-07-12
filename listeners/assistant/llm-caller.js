import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'https://models.github.ai/inference',
  apiKey: process.env.GITHUB_TOKEN,
});

export async function callLLM(messages) {
  const response = await client.chat.completions.create({
    model: 'openai/gpt-4o', // GitHub Models namespaced ID
    messages,
    temperature: 0.7,
    max_tokens: 1000,
  });
  return response.choices[0].message.content;
}
