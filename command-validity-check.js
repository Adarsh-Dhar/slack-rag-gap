import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import log from './agent/logger.js';
import { getOpenAI } from './agent/openai-client.js';
import { isRetryableLLMError, withRetry } from './agent/with-retry.js';

const CHAT_MODEL = 'openai/gpt-4o-mini';
const DOCS_DIR = path.join(process.cwd(), 'docs');
const REPORT_PATH = path.join(process.cwd(), 'command-validity-report.json');

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
async function main() {
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
      const invalid = commands.filter((c) => !c.valid);
      if (invalid.length > 0) {
        log.warn(
          { module: 'command-validity-check', doc: file, invalidCount: invalid.length },
          'Invalid commands found',
        );
      }
      results.push({ doc: file, commands, invalidCount: invalid.length });
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
