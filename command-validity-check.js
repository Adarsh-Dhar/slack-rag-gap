import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { extractCodeSnippets } from './agent/code-extraction.js';
import { githubFetch } from './agent/github-client.js';
import log from './agent/logger.js';
import { getOpenAI } from './agent/openai-client.js';
import { isRetryableLLMError, withRetry } from './agent/with-retry.js';

const CHAT_MODEL = 'openai/gpt-4o';
const DOCS_DIR = path.join(process.cwd(), 'docs');
const REPORT_PATH = path.join(process.cwd(), 'command-validity-report.json');
const REPO_OWNER = process.env.GITHUB_REPO_OWNER || 'Adarsh-Dhar';
const REPO_NAME = process.env.GITHUB_REPO_NAME || 'my-rag-bot';

/**
 * Extracts candidate identifiers (env vars, CLI flags) from fenced code
 * blocks, then checks each against the repo via GitHub's code search —
 * this is the check that actually catches drift; the LLM pass below only
 * catches typos/malformed syntax, which is a weaker, complementary signal.
 *
 * @param {string} body - full doc markdown
 * @returns {Promise<{ token: string, foundInRepo: boolean }[]>}
 */
async function checkTokenExistence(body) {
  const snippets = extractCodeSnippets(body).join('\n');
  const envVars = snippets.match(/\b[A-Z][A-Z0-9_]{3,}\b/g) ?? [];
  const flags = snippets.match(/--[a-z][a-z-]+/g) ?? [];
  const tokens = [...new Set([...envVars, ...flags])];

  const results = [];
  for (const token of tokens) {
    try {
      const query = `${token} repo:${REPO_OWNER}/${REPO_NAME}`;
      const data = await githubFetch(`https://api.github.com/search/code?q=${encodeURIComponent(query)}`);
      results.push({ token, foundInRepo: (data?.total_count ?? 0) > 0 });
    } catch (err) {
      log.debug({ module: 'command-validity-check', token, err: err.message }, 'Token existence check failed');
    }
  }
  return results;
}

/**
 * Given a doc body, asks the LLM to extract all commands mentioned
 * (shell commands, API calls, CLI instructions) and check whether
 * they look syntactically valid and well-formed.
 *
 * @param {string} title
 * @param {string} body
 * @returns {Promise<{ commands: Array<{ command: string, valid: boolean, issue?: string }> }>}
 */
async function checkCommands(title, body) {
  const truncatedBody = body.length > 4000 ? `${body.slice(0, 4000)}\n...(truncated)` : body;

  const res = await withRetry(
    () =>
      getOpenAI().chat.completions.create({
        model: CHAT_MODEL,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content:
              'Extract all commands (shell commands, CLI instructions, API calls) from this document. ' +
              'For each command, assess whether it looks syntactically valid and well-formed. ' +
              'Respond only with JSON: {"commands": [{"command": string, "valid": boolean, "issue": string|null}]}. ' +
              'If no commands are found, return {"commands": []}.',
          },
          {
            role: 'user',
            content: `Title: ${title}\n\nBody:\n${truncatedBody}`,
          },
        ],
      }),
    { isRetryable: isRetryableLLMError, label: 'checkCommands completion' },
  );

  return JSON.parse(res.choices[0].message.content);
}

/**
 * Scans all markdown docs in the docs/ directory for command validity
 * and writes a JSON report.
 */
export async function main() {
  if (!fs.existsSync(DOCS_DIR)) {
    log.debug({ module: 'command-validity-check' }, 'No docs directory found');
    return;
  }

  const files = fs.readdirSync(DOCS_DIR).filter((f) => f.endsWith('.md'));
  const results = [];

  for (const file of files) {
    const content = fs.readFileSync(path.join(DOCS_DIR, file), 'utf-8');
    // Extract title from frontmatter or filename
    const titleMatch = content.match(/^---\s*\ntitle:\s*(.+)/m);
    const title = titleMatch ? titleMatch[1].trim() : file.replace(/\.md$/, '');

    try {
      const { commands } = await checkCommands(title, content);
      const tokenChecks = await checkTokenExistence(content);
      const missingTokens = tokenChecks.filter((t) => !t.foundInRepo);
      const invalid = commands.filter((c) => !c.valid);
      if (invalid.length > 0 || missingTokens.length > 0) {
        log.warn(
          {
            module: 'command-validity-check',
            doc: file,
            invalidCount: invalid.length,
            missingTokens: missingTokens.map((t) => t.token),
          },
          'Invalid commands or missing tokens found',
        );
      }
      results.push({
        doc: file,
        commands,
        invalidCount: invalid.length,
        missingTokens: missingTokens.map((t) => t.token),
      });
    } catch (err) {
      log.error({ module: 'command-validity-check', doc: file, err: err.message }, 'Failed to check commands');
      results.push({ doc: file, commands: [], error: err.message });
    }
  }

  const totalInvalid = results.reduce((sum, r) => sum + (r.invalidCount || 0), 0);
  log.debug({ module: 'command-validity-check', total: results.length, totalInvalid }, 'Check complete');

  const report = {
    checkedAt: new Date().toISOString(),
    total: results.length,
    totalInvalid,
    docs: results,
  };

  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  log.debug({ module: 'command-validity-check', reportPath: REPORT_PATH }, 'Report written');
}

const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith('/command-validity-check.js') || process.argv[1].endsWith('\\command-validity-check.js'));
if (isMain) main();
