import fs from 'node:fs';
import path from 'node:path';
import { classifyDoc } from './doc-classifier.js';
import { getOpenAI } from './openai-client.js';
import { isRetryableLLMError, withRetry } from './with-retry.js';

const CHAT_MODEL = 'openai/gpt-4o-mini';
const DRAFTS_DIR = path.join(process.cwd(), 'docs', 'drafts');
const DOCS_DIR = path.join(process.cwd(), 'docs');

/**
 * Instruction appended to the LLM system prompt telling it to preserve
 * verbatim code blocks from the source thread. Without this, the LLM
 * tends to paraphrase code snippets, losing exact syntax that matters.
 */
export const VERBATIM_INSTRUCTION =
  'IMPORTANT: When including code snippets from the source conversation, ' +
  'copy them VERBATIM — do not paraphrase, rename variables, or change formatting. ' +
  'Wrap all code in fenced code blocks with language tags.';

/**
 * Enforces that the body contains at least one fenced code block. If the
 * LLM dropped the code snippets from the source, re-inserts them at the
 * end of the body under a "## Code Snippets" heading.
 *
 * @param {string} body - LLM-generated body
 * @param {string[]} codeSnippets - extracted code snippets from the source thread
 * @returns {string} body with code blocks guaranteed
 */
export function enforceVerbatimSpans(body, codeSnippets) {
  if (!codeSnippets || codeSnippets.length === 0) return body;
  if (body.includes('```')) return body; // Already has code blocks

  const codeSection = `\n\n## Code Snippets\n\n${codeSnippets.map((s) => `\`\`\`\n${s}\n\`\`\``).join('\n\n')}`;
  return body + codeSection;
}

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
 * @param {{question: string, resolvingText: string, permalink: string, hitCount: number, codeSnippets?: string[]}} input
 * @returns {Promise<{slug: string, filePath: string, title: string, summary: string, doc_type: string}>}
 */
export async function draftStub({ question, resolvingText, permalink, hitCount, codeSnippets = [] }) {
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
              'bulleted list, written as documentation (not as a recap of the conversation). ' +
              VERBATIM_INSTRUCTION,
          },
          {
            role: 'user',
            content:
              `Question asked ${hitCount} time(s): ${question}\n\nAnswer that resolved it:\n${resolvingText}` +
              (codeSnippets.length > 0 ? `\n\nCode snippets from the thread:\n${codeSnippets.join('\n---\n')}` : ''),
          },
        ],
      }),
    { isRetryable: isRetryableLLMError, label: 'draftStub completion' },
  );

  const { title, summary, body: rawBody } = JSON.parse(res.choices[0].message.content);
  const body = enforceVerbatimSpans(rawBody, codeSnippets);
  const slug = slugify(title);

  // Classify the doc type
  let doc_type = 'other';
  try {
    const classification = await classifyDoc({ title, body });
    doc_type = classification.doc_type || 'other';
  } catch {
    // If classification fails, default to 'other' — non-critical
  }

  fs.mkdirSync(DRAFTS_DIR, { recursive: true });
  const filePath = path.join(DRAFTS_DIR, `${slug}.md`);

  const frontmatter = [
    '---',
    `title: ${title}`,
    `status: pending_review`,
    `doc_type: ${doc_type}`,
    `source_thread: ${permalink}`,
    `hit_count: ${hitCount}`,
    `created_at: ${new Date().toISOString()}`,
    '---',
    '',
  ].join('\n');

  fs.writeFileSync(filePath, `${frontmatter}${body}\n`);

  return { slug, filePath, title, summary, doc_type };
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
