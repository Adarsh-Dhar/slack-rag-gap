import fs from 'node:fs';
import { getRecentCommitsForFile } from './github-client.js';

const REPO_OWNER = process.env.GITHUB_REPO_OWNER || 'Adarsh-Dhar';
const REPO_NAME = process.env.GITHUB_REPO_NAME || 'my-rag-bot';

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
 * Scans a directory of markdown docs and checks staleness for each
 * one by looking up corresponding file paths in the repo. Maps doc
 * names to expected file paths using a simple heuristic (docs/foo.md
 * -> docs/foo.md in the repo, or just the filename).
 *
 * @param {string} docsDir - path to the docs directory
 * @param {{ staleDays?: number }} [opts]
 * @returns {Promise<Array<{ doc: string, stale: boolean, lastModified: string | null, daysSinceModified: number | null, author: string | null }>>}
 */
export async function scanDocsStaleness(docsDir, { staleDays = 90 } = {}) {
  if (!fs.existsSync(docsDir)) return [];

  const files = fs.readdirSync(docsDir).filter((f) => f.endsWith('.md'));
  const results = [];

  for (const file of files) {
    const filePath = `docs/${file}`;
    const info = await checkFileStaleness(filePath, { staleDays });
    results.push({ doc: file, ...info });
  }

  return results;
}
