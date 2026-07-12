import { getRecentCommitsForFile } from './github-client.js';

const REPO_OWNER = process.env.GITHUB_REPO_OWNER || 'Adarsh-Dhar';
const REPO_NAME = process.env.GITHUB_REPO_NAME || 'my-rag-bot';

/**
 * Given a file path in the repo, finds the most recent committer using
 * the GitHub commit history. Returns the committer's GitHub username
 * (if available) and the commit date, or null if no commits are found.
 *
 * @param {string} filePath - path within the repo (e.g. "agent/sme-router.js")
 * @returns {Promise<{ login: string, name: string, date: string } | null>}
 */
export async function getRecentCommitter(filePath) {
  const commits = await getRecentCommitsForFile(REPO_OWNER, REPO_NAME, filePath, { per_page: 3 });
  if (!commits || commits.length === 0) return null;

  const latest = commits[0];
  const author = latest.author; // GitHub user object (login) or null
  const commitAuthor = latest.commit?.author; // git commit author {name, date}

  return {
    login: author?.login ?? null,
    name: commitAuthor?.name ?? null,
    date: commitAuthor?.date ?? null,
  };
}

/**
 * Maps a file path to its most recent committer's Slack user ID by
 * cross-referencing with doc-owners.json (which may store GitHub
 * usernames in an `aliases` or `github` field) or returning the raw
 * GitHub login for manual mapping.
 *
 * @param {string} filePath
 * @param {Record<string, { owner?: string, github?: string, aliases?: string[] }>} docOwners
 * @returns {Promise<{ userId: string | null, login: string | null, reason: string }>}
 */
export async function resolveBlameOwner(filePath, docOwners = {}) {
  const committer = await getRecentCommitter(filePath);
  if (!committer) {
    return { userId: null, login: null, reason: 'no commit history found' };
  }

  // Try to match the GitHub login to a known Slack user via doc-owners
  if (committer.login) {
    for (const [docName, entry] of Object.entries(docOwners)) {
      if (entry.github === committer.login || (entry.aliases || []).includes(committer.login)) {
        return {
          userId: entry.owner ?? null,
          login: committer.login,
          reason: `git-blame: ${committer.login} (matched via ${docName})`,
        };
      }
    }
  }

  return {
    userId: null,
    login: committer.login,
    reason: `git-blame: ${committer.login ?? committer.name} (no Slack mapping)`,
  };
}
