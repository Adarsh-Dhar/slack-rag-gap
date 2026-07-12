import fs from 'node:fs';
import path from 'node:path';
import log from './logger.js';
import { withFileLockSync, writeJSONAtomic } from './store.js';
import { withRetry, isRetryableSlackError } from './with-retry.js';

const DOC_OWNERS_PATH = path.join(process.cwd(), 'doc-owners.json');

/**
 * In-memory cache of covered paths, populated by setCoveredPaths() and
 * used by clearDepartedOwners() to know which doc paths are "covered"
 * (i.e. have owners) vs. orphaned.
 */
let _coveredPaths = new Set();

/**
 * Sets the in-memory cache of paths that currently have owners.
 * Called once at startup (e.g. from app.js) so clearDepartedOwners()
 * can compare against it.
 *
 * @param {string[]} paths
 */
export function setCoveredPaths(paths) {
  _coveredPaths = new Set(paths);
}

/**
 * Checks whether a Slack user is still alive (account exists and
 * hasn't been deactivated). Returns true if the user is active.
 *
 * @param {string} userId
 * @returns {Promise<boolean>}
 */
export async function checkOwnerLiveness(userId) {
  return withRetry(
    async () => {
      const { WebClient } = await import('@slack/web-api');
      const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
      const result = await slack.users.info({ user: userId });
      return !result.user.deleted;
    },
    { retries: 3, baseDelayMs: 500, isRetryable: isRetryableSlackError, label: 'checkOwnerLiveness' }
  ).catch((err) => {
    // If the API call fails (missing scope, network error, rate limit),
    // assume the owner is still active rather than silently discarding
    // every tagged-owner match. Only a confirmed `deleted: true` response
    // should remove someone. Log the error so the root cause is visible.
    log.warn({ module: 'doc-owners', userId, err: err.message ?? err }, 'Liveness check failed — assuming alive');
    return true;
  });
}

/**
 * Removes entries from doc-owners.json whose owners are no longer
 * active Slack users (deleted/deactivated accounts). This prevents
 * stale owners from blocking gap drafts and staleness notifications.
 *
 * Returns the list of removed doc keys.
 *
 * @returns {Promise<string[]>}
 */
export async function clearDepartedOwners() {
  const owners = loadDocOwners();
  const removed = [];

  for (const [docName, entry] of Object.entries(owners)) {
    const userId = entry.owner;
    if (!userId?.startsWith('U')) continue;

    const alive = await checkOwnerLiveness(userId);
    if (!alive) {
      removed.push(docName);
      log.warn({ module: 'doc-owners', doc: docName, userId }, 'Removing departed owner');
    }
  }

  if (removed.length === 0) return removed;

  withFileLockSync(DOC_OWNERS_PATH, () => {
    const fresh = loadDocOwners();
    for (const doc of removed) {
      delete fresh[doc];
    }
    writeJSONAtomic(DOC_OWNERS_PATH, fresh);
  });

  return removed;
}

/**
 * Loads and parses the doc-owners.json file. Returns an empty object
 * if the file doesn't exist or contains invalid JSON.
 */
export function loadDocOwners() {
  if (!fs.existsSync(DOC_OWNERS_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(DOC_OWNERS_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

/**
 * Writes the owners object to doc-owners.json (pretty-printed).
 */
export function saveDocOwners(owners) {
  writeJSONAtomic(DOC_OWNERS_PATH, owners);
}

/**
 * Resolves a doc key to its canonical filename. Accepts bare names
 * (e.g. "handbook") and appends .md if the extension is missing.
 */
function resolveDocKey(docName) {
  return docName.endsWith('.md') ? docName : `${docName}.md`;
}

/**
 * Checks whether requesterId is allowed to change ownership of docName.
 *
 * Rules:
 *   - The Slack app creator (APP_CREATOR_ID) can always assign / transfer.
 *   - The current doc owner can transfer to someone else.
 *   - If the doc has no owner yet (or has a placeholder string instead of a
 *     real Slack user ID), only the app creator can make the first assignment.
 *
 * @param {string} docName - Document filename (e.g. "handbook.md")
 * @param {string} requesterId - Slack user ID of the person making the change
 * @returns {{ allowed: boolean, reason?: string }}
 */
export function canChangeOwnership(docName, requesterId) {
  const appCreatorId = process.env.APP_CREATOR_ID;
  if (requesterId === appCreatorId) {
    return { allowed: true };
  }

  const owners = loadDocOwners();
  const currentOwner = owners[docName]?.owner;

  // If there's no real owner yet, only the app creator can assign
  if (!currentOwner?.startsWith('U')) {
    return {
      allowed: false,
      reason: 'This document has no owner yet. Only the app creator can make the initial assignment.',
    };
  }

  if (requesterId === currentOwner) {
    return { allowed: true };
  }

  return {
    allowed: false,
    reason: 'Only the app creator or the current doc owner can change ownership.',
  };
}

/**
 * Assigns or transfers ownership of a document.
 *
 * @param {string} docName - Document filename (e.g. "handbook.md")
 * @param {string} newOwnerId - Slack user ID of the new owner
 * @param {string} requesterId - Slack user ID of the person making the change
 * @returns {{ success: boolean, message: string }}
 */
export function assignOwner(docName, newOwnerId, requesterId) {
  const key = resolveDocKey(docName);

  return withFileLockSync(DOC_OWNERS_PATH, () => {
    const check = canChangeOwnership(key, requesterId);
    if (!check.allowed) {
      return { success: false, message: check.reason };
    }

    const owners = loadDocOwners();
    const previousOwner = owners[key]?.owner ?? null;

    owners[key] = {
      ...owners[key],
      owner: newOwnerId,
      // Seed topic_tags from the filename if this is a brand-new entry
      topic_tags: owners[key]?.topic_tags ?? key.replace(/\.md$/, '').split(/[-_]/).filter(Boolean),
    };

    saveDocOwners(owners);

    const action = previousOwner?.startsWith('U') ? 'transferred' : 'assigned';
    return {
      success: true,
      message: `Ownership of *${key}* ${action} successfully.`,
      previousOwner,
    };
  });
}
