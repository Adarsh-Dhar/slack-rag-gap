import fs from 'fs';
import path from 'path';
import { OpenAI } from 'openai';

const openai = new OpenAI({
  apiKey: process.env.GITHUB_TOKEN,
  baseURL: 'https://models.github.ai/inference',
});
const CHAT_MODEL = 'openai/gpt-4o-mini';
const DRAFTS_DIR = path.join(process.cwd(), 'docs', 'drafts');

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 60);
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
  const res = await openai.chat.completions.create({
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
  });

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
