import fs from 'fs';
import path from 'path';
import { withFileLockSync, writeJSONAtomic } from './store.js';

const PROCESS_OWNERS_PATH = path.join(process.cwd(), 'process-owners.json');

/**
 * Loads and parses the process-owners.json file. Returns an empty object
 * if the file doesn't exist yet (e.g. before anyone has tagged an owner)
 * or contains invalid JSON.
 */
export function loadProcessOwners() {
  if (!fs.existsSync(PROCESS_OWNERS_PATH)) return {};
  try {
    const data = JSON.parse(fs.readFileSync(PROCESS_OWNERS_PATH, 'utf-8'));
    delete data._comment;
    return data;
  } catch {
    return {};
  }
}

/**
 * Writes the owners object to process-owners.json (pretty-printed).
 */
export function saveProcessOwners(owners) {
  writeJSONAtomic(PROCESS_OWNERS_PATH, owners);
}

/**
 * Resolves a free-form topic name (e.g. "payment retries") to its
 * canonical key (e.g. "payment-retries"). Keys are lowercase with
 * whitespace collapsed to hyphens, so the same topic always maps to the
 * same entry regardless of how someone phrases it in Slack.
 */
function resolveTopicKey(topic) {
  return topic.trim().toLowerCase().replace(/\s+/g, '-');
}

/**
 * Default keywords for a brand-new topic: the individual words from the
 * topic name plus the full phrase itself, so matchProcessOwner() (simple
 * substring containment against a question) has something reasonable to
 * match on even before anyone hand-tunes the keyword list.
 */
function defaultKeywords(topic) {
  const words = topic
    .toLowerCase()
    .split(/[\s\-_]+/)
    .filter(Boolean);
  const phrase = topic.trim().toLowerCase();
  return [...new Set([phrase, ...words])];
}

/**
 * Checks whether requesterId is allowed to change ownership of a topic.
 *
 * Rules (identical to doc-owners.js's canChangeOwnership):
 *   - The Slack app creator (APP_CREATOR_ID) can always assign / transfer.
 *   - The current owner can transfer to someone else.
 *   - If the topic has no owner yet (or has a placeholder string instead of
 *     a real Slack user ID), only the app creator can make the first
 *     assignment.
 *
 * @param {string} topicKey - Canonical topic key (e.g. "checkout")
 * @param {string} requesterId - Slack user ID of the person making the change
 * @returns {{ allowed: boolean, reason?: string }}
 */
export function canChangeProcessOwnership(topicKey, requesterId) {
  const appCreatorId = process.env.APP_CREATOR_ID;
  if (requesterId === appCreatorId) {
    return { allowed: true };
  }

  const owners = loadProcessOwners();
  const currentOwner = owners[topicKey]?.owner;

  if (!currentOwner || !currentOwner.startsWith('U')) {
    return {
      allowed: false,
      reason: 'This process has no owner yet. Only the app creator can make the initial assignment.',
    };
  }

  if (requesterId === currentOwner) {
    return { allowed: true };
  }

  return {
    allowed: false,
    reason: 'Only the app creator or the current process owner can change ownership.',
  };
}

/**
 * Assigns or transfers ownership of a topic/process.
 *
 * @param {string} topicName - Free-form topic name (e.g. "checkout")
 * @param {string} newOwnerId - Slack user ID of the new owner
 * @param {string} requesterId - Slack user ID of the person making the change
 * @param {string[]} [newKeywords] - Optional keyword list to set/replace on
 *   this assignment. If omitted, existing keywords are kept, or seeded from
 *   the topic name if this is a brand-new entry.
 * @returns {{ success: boolean, message: string, previousOwner?: string|null }}
 */
export function assignProcessOwner(topicName, newOwnerId, requesterId, newKeywords) {
  const key = resolveTopicKey(topicName);

  return withFileLockSync(PROCESS_OWNERS_PATH, () => {
    const check = canChangeProcessOwnership(key, requesterId);
    if (!check.allowed) {
      return { success: false, message: check.reason };
    }

    const owners = loadProcessOwners();
    const previousOwner = owners[key]?.owner ?? null;

    owners[key] = {
      ...owners[key],
      owner: newOwnerId,
      keywords:
        newKeywords && newKeywords.length > 0 ? newKeywords : (owners[key]?.keywords ?? defaultKeywords(topicName)),
    };

    saveProcessOwners(owners);

    const action = previousOwner && previousOwner.startsWith('U') ? 'transferred' : 'assigned';
    return {
      success: true,
      message: `Process ownership of *${key}* ${action} successfully. I'll route questions matching its keywords (${owners[key].keywords.join(', ')}) to <@${newOwnerId}>.`,
      previousOwner,
    };
  });
}
