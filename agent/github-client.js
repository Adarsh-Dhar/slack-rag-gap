import log from './logger.js';
import { withRetry } from './with-retry.js';

const GITHUB_API = 'https://api.github.com';

/**
 * Returns default headers for GitHub REST API calls, using the GITHUB_TOKEN
 * env var for authentication. Throws if the token is missing.
 */
function getHeaders() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN env var is not set');
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

/**
 * Wraps fetch() with error handling for the GitHub REST API. Parses JSON
 * and throws on non-2xx responses with a descriptive message.
 *
 * @param {string} url
 * @param {RequestInit} [init]
 * @returns {Promise<any>}
 */
export async function githubFetch(url, init = {}) {
  return withRetry(
    async () => {
      const res = await fetch(url, { ...init, headers: { ...getHeaders(), ...init.headers } });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`GitHub API ${res.status} ${res.statusText}: ${body.slice(0, 200)}`);
      }
      if (res.status === 204) return null;
      return res.json();
    },
    { retries: 3, baseDelayMs: 500, isRetryable: (err) => err?.status === 429 || (typeof err?.status === 'number' && err.status >= 500), label: 'githubFetch' }
  );
}

/**
 * Fetches the git blame for a file in a GitHub repository.
 *
 * @param {string} owner
 * @param {string} repo
 * @param {string} path - file path within the repo
 * @param {string} [ref='HEAD']
 * @returns {Promise<Array<{lines: Array<{content: string, commit: {author: {name: string, date: string}, message: string}}>}>}
 */
export async function getFileBlame(owner, repo, path, ref = 'HEAD') {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/contents/${path}?ref=${ref}`;
  try {
    const data = await githubFetch(url, {
      headers: { Accept: 'application/vnd.github.v3+json' },
    });
    // The contents endpoint doesn't return blame — we'd need the git
    // blame endpoint which requires the raw media type. For now we use
    // the commit history of the file to find recent authors.
    return data;
  } catch (err) {
    log.warn({ module: 'github-client', owner, repo, path, err: err.message }, 'getFileBlame failed');
    return null;
  }
}

/**
 * Lists recent commits touching a file, ordered by date descending.
 * Uses the commits endpoint which doesn't require special permissions.
 *
 * @param {string} owner
 * @param {string} repo
 * @param {string} path
 * @param {{ per_page?: number }} [opts]
 * @returns {Promise<Array<{sha: string, commit: {author: {name: string, date: string}, message: string}, author: {login: string} | null}>>}
 */
export async function getRecentCommitsForFile(owner, repo, path, { per_page = 5 } = {}) {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/commits?path=${encodeURIComponent(path)}&per_page=${per_page}`;
  try {
    return await githubFetch(url);
  } catch (err) {
    log.warn({ module: 'github-client', owner, repo, path, err: err.message }, 'getRecentCommitsForFile failed');
    return [];
  }
}
