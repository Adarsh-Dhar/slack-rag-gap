import fs from 'fs';
import path from 'path';

const DOC_OWNERS_PATH = path.join(process.cwd(), 'doc-owners.json');

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
  fs.writeFileSync(DOC_OWNERS_PATH, JSON.stringify(owners, null, 2));
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
  if (!currentOwner || !currentOwner.startsWith('U')) {
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

  const action = previousOwner && previousOwner.startsWith('U') ? 'transferred' : 'assigned';
  return {
    success: true,
    message: `Ownership of *${key}* ${action} successfully.`,
    previousOwner,
  };
}
