import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { WebClient } from '@slack/web-api';
import log from './agent/logger.js';

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
const docOwnersPath = path.join(process.cwd(), 'doc-owners.json');
const REPORT_PATH = path.join(process.cwd(), 'owner-liveness-report.json');

/**
 * Checks whether a Slack user is still active (exists and hasn't been
 * deactivated). Returns liveness info including whether the user
 * account is active, their real name, and profile status.
 *
 * @param {string} userId - Slack user ID (e.g. "U12345")
 * @returns {Promise<{ alive: boolean, deleted?: boolean, real_name?: string, status?: string, error?: string }>}
 */
async function checkUserLiveness(userId) {
  try {
    const result = await slack.users.info({ user: userId });
    const user = result.user;
    return {
      alive: !user.deleted && !user.is_ultra_restricted,
      deleted: user.deleted,
      real_name: user.real_name,
      status: user.profile?.status_text ?? '',
    };
  } catch (err) {
    return { alive: false, error: err.message };
  }
}

/**
 * Scans doc-owners.json and checks liveness for each owner.
 * Returns a report of which owners are still active and which have
 * departed or are unreachable.
 */
async function main() {
  if (!fs.existsSync(docOwnersPath)) {
    log.debug({ module: 'owner-liveness-check' }, 'No doc-owners.json found');
    return;
  }

  const owners = JSON.parse(fs.readFileSync(docOwnersPath, 'utf-8'));
  const results = [];

  for (const [doc, entry] of Object.entries(owners)) {
    const userId = entry.owner;
    if (!userId?.startsWith('U')) {
      results.push({ doc, userId, alive: false, reason: 'invalid user ID' });
      continue;
    }

    const liveness = await checkUserLiveness(userId);
    results.push({ doc, userId, ...liveness });

    if (!liveness.alive) {
      log.warn(
        { module: 'owner-liveness-check', doc, userId, error: liveness.error ?? 'deleted' },
        'Owner liveness check failed',
      );
    }
  }

  const departed = results.filter((r) => !r.alive);
  log.debug(
    { module: 'owner-liveness-check', total: results.length, departed: departed.length },
    'Liveness check complete',
  );

  const report = {
    checkedAt: new Date().toISOString(),
    total: results.length,
    departed: departed.length,
    docs: results,
  };

  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  log.debug({ module: 'owner-liveness-check', reportPath: REPORT_PATH }, 'Report written');
}

const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith('/owner-liveness-check.js') || process.argv[1].endsWith('\\owner-liveness-check.js'));
if (isMain) main();
