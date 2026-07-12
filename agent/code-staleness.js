import fs from 'node:fs';
import { getRecentCommitsForFile } from './github-client.js';

const REPO_OWNER = process.env.GITHUB_REPO_OWNER || 'Adarsh-Dhar';
const REPO_NAME = process.env.GITHUB_REPO_NAME || 'my-rag-bot';

/**
 * Reads the `covers` frontmatter array from a doc, if present.
 * @param {string} filePath - absolute path to the .md file
 * @returns {{ covers: string[], createdAt: string | null }}
 */
function readCoversFrontmatter(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const coversMatch = content.match(/^covers:\s*\[(.*)\]/m);
  const createdMatch = content.match(/^created_at:\s*(.+)/m);
  const covers = coversMatch
    ? coversMatch[1]
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean)
    : [];
  return { covers, createdAt: createdMatch ? createdMatch[1].trim() : null };
}

/**
 * Checks whether any path a doc claims to "cover" has commits landed
 * after the doc's created_at — i.e. the code moved on but the doc didn't.
 *
 * @param {string} docFilePath - absolute path to the .md file
 * @returns {Promise<{ drifted: boolean, driftedPaths: string[] }>}
 */
export async function checkCoverageDrift(docFilePath) {
  const { covers, createdAt } = readCoversFrontmatter(docFilePath);
  if (covers.length === 0 || !createdAt) return { drifted: false, driftedPaths: [] };

  const driftedPaths = [];
  for (const coveredPath of covers) {
    const commits = await getRecentCommitsForFile(REPO_OWNER, REPO_NAME, coveredPath, { per_page: 5 });
    const landedAfter = commits.filter((c) => new Date(c.commit?.author?.date) > new Date(createdAt));
    if (landedAfter.length > 0) driftedPaths.push(coveredPath);
  }
  return { drifted: driftedPaths.length > 0, driftedPaths };
}

/**
 * Checks whether a file in the GitHub repo has been modified recently
 * (within the given threshold). Returns staleness info including the
 * last commit date and whether the file is considered stale.
 *
 * @param {string} filePath - path within the repo
 * @param {{ staleDays?: number }} [opts]
 * @returns {Promise<{ stale: boolean, lastModified: string | null, daysSinceModified: number | null, author: string | null }>}
 */
export async function checkFileStaleness(filePath, { staleDays = 90 } = {}) {
  const commits = await getRecentCommitsForFile(REPO_OWNER, REPO_NAME, filePath, { per_page: 1 });
  if (!commits || commits.length === 0) {
    return { stale: true, lastModified: null, daysSinceModified: null, author: null };
  }

  const latest = commits[0];
  const lastModifiedDate = latest.commit?.author?.date;
  if (!lastModifiedDate) {
    return { stale: true, lastModified: null, daysSinceModified: null, author: null };
  }

  const daysSince = (Date.now() - new Date(lastModifiedDate).getTime()) / (1000 * 60 * 60 * 24);

  return {
    stale: daysSince > staleDays,
    lastModified: lastModifiedDate,
    daysSinceModified: Math.round(daysSince),
    author: latest.author?.login ?? latest.commit?.author?.name ?? null,
  };
}

/**
 * Scans a directory of markdown docs and checks staleness for each one.
 * First tries coverage-drift check (docs with `covers` frontmatter), then
 * falls back to doc-file-commit-age as a weaker secondary signal.
 *
 * @param {string} docsDir - path to the docs directory
 * @param {{ staleDays?: number }} [opts]
 * @returns {Promise<Array<{ doc: string, stale: boolean, reason?: string, driftedPaths?: string[], lastModified?: string | null, daysSinceModified?: number | null, author?: string | null }>>}
 */
export async function scanDocsStaleness(docsDir, { staleDays = 90 } = {}) {
  if (!fs.existsSync(docsDir)) return [];

  const files = fs.readdirSync(docsDir).filter((f) => f.endsWith('.md'));
  const results = [];

  for (const file of files) {
    const absPath = `${docsDir}/${file}`;
    const coverage = await checkCoverageDrift(absPath);
    if (coverage.drifted) {
      results.push({ doc: file, stale: true, reason: 'code-drift', driftedPaths: coverage.driftedPaths });
      continue;
    }
    // No covers binding (or no drift) — fall back to the existing
    // doc-file-commit-age check as a weaker secondary signal.
    const filePath = `docs/${file}`;
    const info = await checkFileStaleness(filePath, { staleDays });
    results.push({ doc: file, ...info });
  }

  return results;
}
