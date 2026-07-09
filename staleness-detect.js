import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { WebClient } from '@slack/web-api';
import { notifyStakeholder } from './agent/notify-stakeholder.js';

const docOwnersPath = path.join(process.cwd(), 'doc-owners.json');
const docOwners = fs.existsSync(docOwnersPath)
  ? JSON.parse(fs.readFileSync(docOwnersPath, 'utf-8'))
  : {};

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

const USAGE_PATH = path.join(process.cwd(), 'doc-usage.json');
const NOTIFIED_PATH = path.join(process.cwd(), 'staleness-notified.json');

export const COOLDOWN_MS = 168 * 60 * 60 * 1000; // 7 days in milliseconds

/**
 * Parses the STALENESS_THRESHOLD environment variable.
 * Falls back to 0.3 if the value is absent or not a finite number.
 *
 * @param {string|undefined} envValue
 * @returns {number}
 */
export function parseThreshold(envValue) {
  const parsed = parseFloat(envValue);
  if (!Number.isFinite(parsed)) {
    console.log(`STALENESS_THRESHOLD not set or invalid ("${envValue}") — using default 0.3`);
    return 0.3;
  }
  return parsed;
}

/**
 * Slugifies a string: lowercase, replace non-alphanumeric runs with hyphens,
 * strip leading/trailing hyphens, truncate to 60 chars.
 * Identical to the slugify() function in agent/draft-generator.js.
 *
 * @param {string} s
 * @returns {string}
 */
export function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 60);
}

/**
 * Computes the staleness score for a doc entry.
 *
 * @param {{ citedCount: number, followUpCount: number, correctionCount: number }} entry
 * @returns {number}
 */
export function computeStalenessScore({ citedCount, followUpCount, correctionCount }) {
  return (followUpCount + 2 * correctionCount) / Math.max(citedCount, 1);
}

/**
 * Returns true if the stored timestamp for a doc is within the cooldown window.
 *
 * @param {string|undefined} storedTimestamp - ISO-8601 string or undefined
 * @param {number} now - Current time in ms (Date.now())
 * @returns {boolean}
 */
export function isInCooldown(storedTimestamp, now) {
  if (!storedTimestamp) return false;
  const storedMs = new Date(storedTimestamp).getTime();
  return now - storedMs < COOLDOWN_MS;
}

export async function main() {
  const STALENESS_THRESHOLD = parseThreshold(process.env.STALENESS_THRESHOLD);

  // Load doc-usage.json; exit cleanly if absent or empty
  if (!fs.existsSync(USAGE_PATH)) {
    console.log('no usage data');
    process.exit(0);
  }

  let usage;
  try {
    usage = JSON.parse(fs.readFileSync(USAGE_PATH, 'utf-8'));
  } catch {
    console.log('no usage data');
    process.exit(0);
  }

  if (!usage || Object.keys(usage).length === 0) {
    console.log('no usage data');
    process.exit(0);
  }

  // Load staleness-notified.json; treat as {} if absent
  let notified = {};
  if (fs.existsSync(NOTIFIED_PATH)) {
    try {
      notified = JSON.parse(fs.readFileSync(NOTIFIED_PATH, 'utf-8'));
    } catch {
      notified = {};
    }
  }

  const now = Date.now();

  for (const [docName, entry] of Object.entries(usage)) {
    const { citedCount, followUpCount, correctionCount } = entry;

    const stalenessScore = computeStalenessScore({ citedCount, followUpCount, correctionCount });

    // Skip docs below or at threshold
    if (stalenessScore <= STALENESS_THRESHOLD) continue;

    // Skip docs within cooldown window
    if (isInCooldown(notified[docName], now)) {
      console.log(`Skipping "${docName}" — within 7-day cooldown window`);
      continue;
    }

    // Look up doc owner; warn and skip if not found
    if (!docOwners[docName] || docOwners[docName].owner === undefined) {
      console.warn(`No owner found for "${docName}" in doc-owners.json — skipping`);
      continue;
    }

    const ownerId = docOwners[docName].owner;

    // Build the staleness draft object
    const draft = {
      slug: `${slugify(docName)}-staleness-review`,
      title: `${docName} — Staleness Review`,
      summary: `Staleness score: ${stalenessScore.toFixed(2)} (${citedCount} citations, ${followUpCount} follow-ups, ${correctionCount} corrections)`,
      permalink: '',
      diff: null,
    };

    // Notify the doc owner
    try {
      await notifyStakeholder(slack, draft, ownerId);
    } catch (err) {
      console.error(`Error notifying owner of "${docName}":`, err.message ?? err);
      continue;
    }

    // Update staleness-notified.json atomically (write tmp then rename)
    const updated = { ...notified, [docName]: new Date().toISOString() };
    const tmpPath = `${NOTIFIED_PATH}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(updated, null, 2));
    fs.renameSync(tmpPath, NOTIFIED_PATH);

    // Update in-memory state for subsequent iterations
    notified = updated;

    console.log(`Notified owner "${ownerId}" about stale doc "${docName}" (score: ${stalenessScore.toFixed(2)})`);
  }
}

// Only run main() when this file is executed directly, not when imported by tests.
const isMain = process.argv[1] && (
  process.argv[1].endsWith('/staleness-detect.js') ||
  process.argv[1].endsWith('\\staleness-detect.js')
);
if (isMain) main();
