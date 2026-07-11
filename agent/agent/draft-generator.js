import fs from 'fs';
import path from 'path';
import { getOpenAI } from './openai-client.js';
import { isRetryableLLMError, withRetry } from './with-retry.js';

const CHAT_MODEL = 'openai/gpt-4o-mini';
const DRAFTS_DIR = path.join(process.cwd(), 'docs', 'drafts');
const DOCS_DIR = path.join(process.cwd(), 'docs');

export function slugify(s) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 60);
}

/**
 * Drafts a doc stub from a gap question + the reply that resolved it, and
 * writes it to docs/drafts/ as markdown with frontmatter provenance. Does
 * NOT touch the live knowledge base — that only happens on stakeholder
 * approval (see listeners/actions/draft_approval.js).
 *
 * @param {{question: string, resolvingText: string, permalink: string, hitCount: number}} input
 * @returns {Promise<{slug: string, filePath: string, title: string, summary: string}>}
 */
export async function draftStub({ question, resolvingText, permalink, hitCount }) {
  const res = await withRetry(
    () =>
      getOpenAI().chat.completions.create({
        model: CHAT_MODEL,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content:
              'Draft a short internal doc stub from a question and the reply that answered it. ' +
              'Respond only with JSON: {"title": string, "summary": string, "body": string}. ' +
              'title: <=8 words. summary: one sentence. body: markdown, 2-4 short paragraphs or a ' +
              'bulleted list, written as documentation (not as a recap of the conversation).',
          },
          {
            role: 'user',
            content: `Question asked ${hitCount} time(s): ${question}\n\nAnswer that resolved it:\n${resolvingText}`,
          },
        ],
      }),
    { isRetryable: isRetryableLLMError, label: 'draftStub completion' },
  );

  const { title, summary, body } = JSON.parse(res.choices[0].message.content);
  const slug = slugify(title);

  fs.mkdirSync(DRAFTS_DIR, { recursive: true });
  const filePath = path.join(DRAFTS_DIR, `${slug}.md`);

  const frontmatter = [
    '---',
    `title: ${title}`,
    `status: pending_review`,
    `source_thread: ${permalink}`,
    `hit_count: ${hitCount}`,
    `created_at: ${new Date().toISOString()}`,
    '---',
    '',
  ].join('\n');

  fs.writeFileSync(filePath, `${frontmatter}${body}\n`);

  return { slug, filePath, title, summary };
}

/**
 * Drafts a minimal correction edit against an existing document. Reads the
 * live document from docs/{docSource}, asks the LLM to produce only the
 * sentences directly contradicted by correctionText, and writes the result
 * to docs/drafts/ with edit_of frontmatter.
 *
 * @param {{
 *   docSource: string,       // e.g. "handbook.md"
 *   correctionText: string,  // human's correction from Slack thread
 *   permalink: string,       // Slack thread permalink
 * }} input
 * @returns {Promise<{slug: string, filePath: string, title: string, summary: string, diff: string}>}
 * @throws {Error} "Source document not found: {docSource}" if docs/{docSource} doesn't exist
 */
export async function draftCorrection({ docSource, correctionText, permalink }) {
  const sourceFilePath = path.join(DOCS_DIR, docSource);

  let originalContent;
  try {
    originalContent = fs.readFileSync(sourceFilePath, 'utf-8');
  } catch {
    throw new Error(`Source document not found: ${docSource}`);
  }

  const res = await withRetry(
    () =>
      getOpenAI().chat.completions.create({
        model: CHAT_MODEL,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content:
              'You are a technical editor. You will receive an existing document and a correction. ' +
              'Produce a MINIMAL edit — change ONLY the sentences or sections directly contradicted by the correction. ' +
              'Do NOT rewrite the full document. ' +
              'Respond only with JSON: {"title": string, "summary": string, "body": string, "diff": string}. ' +
              'title: <=8 words describing the correction. ' +
              'summary: one sentence describing what was corrected. ' +
              'body: the full corrected document in markdown. ' +
              'diff: a unified diff string showing only the changed lines (empty string if no diff available).',
          },
          {
            role: 'user',
            content:
              `Existing document (${docSource}):\n${originalContent}\n\n` + `Correction from user:\n${correctionText}`,
          },
        ],
      }),
    { isRetryable: isRetryableLLMError, label: 'draftCorrection completion' },
  );

  const { title, summary, body, diff } = JSON.parse(res.choices[0].message.content);
  const slug = slugify(title);

  fs.mkdirSync(DRAFTS_DIR, { recursive: true });
  const filePath = path.join(DRAFTS_DIR, `${slug}.md`);

  const frontmatter = [
    '---',
    `title: ${title}`,
    `status: pending_review`,
    `edit_of: ${docSource}`,
    `source_thread: ${permalink}`,
    `created_at: ${new Date().toISOString()}`,
    '---',
    '',
  ].join('\n');

  fs.writeFileSync(filePath, `${frontmatter}${body}\n`);

  return { slug, filePath, title, summary, diff: diff ?? '' };
}
