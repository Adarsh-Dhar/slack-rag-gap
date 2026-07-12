import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { WebClient } from '@slack/web-api';
import { checkFileStaleness } from './agent/code-staleness.js';
import log from './agent/logger.js';
import { notifyStakeholder } from './agent/notify-stakeholder.js';
import { readJSON, withFileLockSync, writeJSONAtomic } from './agent/store.js';

const docOwnersPath = path.join(process.cwd(), 'doc-owners.json');

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

const USAGE_PATH = path.join(process.cwd(), 'doc-usage.json');
const NOTIFIED_PATH = path.join(process.cwd(), 'staleness-notified.json');
const DRAFTS_DIR = path.join(process.cwd(), 'docs', 'drafts');
const DOCS_DIR = path.join(process.cwd(), 'docs');

export const COOLDOWN_MS = 168 * 60 * 60 * 1000; // 7 days in milliseconds

/**
 * Doc-type-aware staleness threshold multipliers. Each doc_type from the
 * frontmatter gets a multiplier applied to the base STALENESS_THRESHOLD.
 * Lower multiplier = more lenient (needs more corrections to trigger).
 * Higher multiplier = more aggressive (triggers sooner).
 *
 * Runbooks and API docs are mission-critical and should be checked more
 * aggressively. Design docs and onboarding materials can be more lenient.
 */
const DOC_TYPE_MULTIPLIERS = {
  runbook: 0.7, // More aggressive — operational docs must be accurate
  api: 0.7, // More aggressive — API docs must match reality
  policy: 0.8, // Slightly more aggressive — policies must be current
  design: 1.2, // More lenient — design docs can age gracefully
  onboarding: 1.1, // Slightly more lenient — onboarding evolves slowly
  reference: 1.0, // Default
  other: 1.0, // Default
};

/**
 * Code-stale bypass: if the underlying code file hasn't been modified
 * in the repo within this many days, the doc is considered stale
 * regardless of usage metrics. This catches docs that reference code
 * that has moved or changed.
 */
const CODE_STALE_DAYS = parseInt(process.env.CODE_STALE_DAYS, 10) || 90;

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
    log.debug({ module: 'staleness-detect', envValue }, 'STALENESS_THRESHOLD not set or invalid — using default 0.3');
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
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 60);
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
  // Re-read doc-owners.json on every run so ownership changes made via
  // Slack commands (or manual edits) are picked up without a restart.
  const docOwners = fs.existsSync(docOwnersPath) ? JSON.parse(fs.readFileSync(docOwnersPath, 'utf-8')) : {};

  const BASE_STALENESS_THRESHOLD = parseThreshold(process.env.STALENESS_THRESHOLD);

  // Load doc-usage.json; exit cleanly if absent or empty
  if (!fs.existsSync(USAGE_PATH)) {
    log.debug({ module: 'staleness-detect' }, 'No usage data file found');
    process.exit(0);
  }

  let usage;
  try {
    usage = JSON.parse(fs.readFileSync(USAGE_PATH, 'utf-8'));
  } catch {
    log.debug({ module: 'staleness-detect' }, 'Could not parse usage data');
    process.exit(0);
  }

  if (!usage || Object.keys(usage).length === 0) {
    log.debug({ module: 'staleness-detect' }, 'Usage data is empty');
    process.exit(0);
  }

  const now = Date.now();

  for (const [docName, entry] of Object.entries(usage)) {
    const { citedCount, followUpCount, correctionCount } = entry;

    const stalenessScore = computeStalenessScore({ citedCount, followUpCount, correctionCount });

    // Determine doc_type from frontmatter if available
    let doc_type = 'other';
    try {
      const docPath = path.join(DOCS_DIR, docName);
      if (fs.existsSync(docPath)) {
        const content = fs.readFileSync(docPath, 'utf-8');
        const docTypeMatch = content.match(/^---\s*\ndoc_type:\s*(.+)/m);
        if (docTypeMatch) doc_type = docTypeMatch[1].trim();
      }
    } catch {
      // Non-critical — default to 'other'
    }

    // Apply doc-type-aware threshold
    const typeMultiplier = DOC_TYPE_MULTIPLIERS[doc_type] ?? 1.0;
    const STALENESS_THRESHOLD = BASE_STALENESS_THRESHOLD * typeMultiplier;

    // Code-stale bypass: if the underlying code file hasn't been updated
    // within CODE_STALE_DAYS, consider the doc stale regardless of usage
    let codeStale = false;
    try {
      const codeFile = docName.replace(/\.md$/, '.js'); // Heuristic: docs/foo.md -> docs/foo.js
      const codePath = `docs/${codeFile}`;
      const codeStaleness = await checkFileStaleness(codePath, { staleDays: CODE_STALE_DAYS });
      codeStale = codeStaleness.stale;
    } catch {
      // Non-critical — if we can't check code staleness, fall back to usage-only
    }

    // Skip docs below or at threshold (unless code is stale)
    if (stalenessScore <= STALENESS_THRESHOLD && !codeStale) continue;

    // Look up doc owner; warn and skip if not found
    if (!docOwners[docName] || docOwners[docName].owner === undefined) {
      log.warn({ module: 'staleness-detect', doc: docName }, 'No owner found in doc-owners.json — skipping');
      continue;
    }

    const ownerId = docOwners[docName].owner;

    // Atomically check-and-reserve this doc: re-reads staleness-notified.json
    // fresh under the lock (rather than trusting the `notified` snapshot
    // loaded at the top of main()) so two concurrent staleness-detect runs
    // — two overlapping manual runs, or two worker replicas — can't both
    // decide the doc is out of its cooldown window and both fire a DM.
    // Whichever one wins the lock first reserves it; the other sees the
    // fresh write and backs off.
    const reserved = withFileLockSync(NOTIFIED_PATH, () => {
      const fresh = readJSON(NOTIFIED_PATH, {});
      if (isInCooldown(fresh[docName], now)) return false;
      fresh[docName] = new Date().toISOString();
      writeJSONAtomic(NOTIFIED_PATH, fresh);
      return true;
    });

    if (!reserved) {
      log.debug({ module: 'staleness-detect', doc: docName }, 'Within 7-day cooldown — skipping');
      continue;
    }

    // Build the staleness draft object
    const slug = `${slugify(docName)}-staleness-review`;
    const draft = {
      slug,
      title: `${docName} — Staleness Review`,
      summary: `Staleness score: ${stalenessScore.toFixed(2)} (${citedCount} citations, ${followUpCount} follow-ups, ${correctionCount} corrections)`,
      permalink: '',
      diff: null,
    };

    // Write the draft file to docs/drafts/ so the Approve/Edit/Reject
    // buttons in the notification have an actual file to operate on.
    // Without this, draftApprovalCallback always returns "Draft not found".
    fs.mkdirSync(DRAFTS_DIR, { recursive: true });
    const draftFilePath = path.join(DRAFTS_DIR, `${slug}.md`);
    const existingDocPath = path.join(DOCS_DIR, docName);
    let existingContent = '';
    try {
      existingContent = fs.readFileSync(existingDocPath, 'utf-8');
    } catch {
      existingContent = `_(${docName} — original content not found)_`;
    }
    const frontmatter = [
      '---',
      `title: ${draft.title}`,
      `status: staleness_review`,
      `staleness_score: ${stalenessScore.toFixed(2)}`,
      `cited_count: ${citedCount}`,
      `follow_up_count: ${followUpCount}`,
      `correction_count: ${correctionCount}`,
      `created_at: ${new Date().toISOString()}`,
      '---',
      '',
    ].join('\n');
    fs.writeFileSync(draftFilePath, `${frontmatter}${existingContent}\n`);

    // Notify the doc owner
    try {
      await notifyStakeholder(slack, draft, ownerId);
    } catch (err) {
      log.error(
        { module: 'staleness-detect', doc: docName, err: err.message ?? err },
        'Failed to notify owner of stale doc',
      );
      // The DM never actually landed — release the reservation so this doc
      // is eligible again next cycle instead of silently staying "notified"
      // for a full 7-day cooldown it never earned.
      withFileLockSync(NOTIFIED_PATH, () => {
        const fresh = readJSON(NOTIFIED_PATH, {});
        delete fresh[docName];
        writeJSONAtomic(NOTIFIED_PATH, fresh);
      });
      continue;
    }

    log.debug(
      { module: 'staleness-detect', doc: docName, ownerId, score: Number(stalenessScore.toFixed(2)) },
      'Notified owner about stale doc',
    );
  }
}

// Only run main() when this file is executed directly, not when imported by tests.
const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith('/staleness-detect.js') || process.argv[1].endsWith('\\staleness-detect.js'));
if (isMain) main();
