import { OpenAI } from 'openai';

let client = null;

/**
 * Lazily constructs (and memoizes) the OpenAI-compatible client pointed at
 * GitHub Models. Every module that talks to the LLM should call this
 * instead of constructing its own `new OpenAI({...})` at import time.
 *
 * Why: constructing the client at module load time means simply
 * *importing* a file like agent/draft-generator.js throws if GITHUB_TOKEN
 * isn't set — even for a test that never calls the LLM. Deferring
 * construction to first actual use means import-time is side-effect-free,
 * and the error only shows up when something genuinely needs credentials.
 */
export function getOpenAI() {
  if (!client) {
    client = new OpenAI({
      apiKey: process.env.GITHUB_TOKEN,
      baseURL: 'https://models.github.ai/inference',
    });
  }
  return client;
}

/**
 * Test-only escape hatch: clears the memoized client so tests can swap in
 * mocks/stubs between cases without stale state leaking across them.
 */
export function resetOpenAIClient() {
  client = null;
}
