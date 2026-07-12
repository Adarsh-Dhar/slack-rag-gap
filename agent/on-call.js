import fs from 'node:fs';
import path from 'node:path';

const ON_CALL_PATH = path.join(process.cwd(), 'on-call.json');

/**
 * Loads the on-call.json config file. Expected format:
 * {
 *   "rotation": [
 *     { "userId": "U123", "label": "Alice", "startDay": "monday", "endDay": "wednesday" },
 *     { "userId": "U456", "label": "Bob", "startDay": "thursday", "endDay": "sunday" }
 *   ],
 *   "fallback": "U789"
 * }
 *
 * startDay/endDay are lowercase English day names. If omitted, the entry
 * applies every day. The first matching entry is returned.
 *
 * @returns {object|null}
 */
function loadOnCallConfig() {
  if (!fs.existsSync(ON_CALL_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(ON_CALL_PATH, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Returns the current day name as a lowercase English string (e.g. "monday").
 * @returns {string}
 */
function currentDay() {
  return ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][new Date().getDay()];
}

/**
 * Day index for cyclic range comparison. Sunday=0, Monday=1, ..., Saturday=6.
 * @param {string} day
 */
function dayIndex(day) {
  const map = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
  return map[day] ?? -1;
}

/**
 * Returns the on-call person for today based on the rotation config.
 * Returns null if no config exists or no rotation entry matches today.
 *
 * @returns {{ userId: string, label: string, reason: string } | null}
 */
export function getOnCallPerson() {
  const config = loadOnCallConfig();
  if (!config || !Array.isArray(config.rotation) || config.rotation.length === 0) return null;

  const today = currentDay();
  const todayIdx = dayIndex(today);

  for (const entry of config.rotation) {
    if (!entry.userId) continue;

    // If no day range specified, applies every day
    if (!entry.startDay || !entry.endDay) {
      return { userId: entry.userId, label: entry.label ?? entry.userId, reason: 'on-call (no day range)' };
    }

    const startIdx = dayIndex(entry.startDay);
    const endIdx = dayIndex(entry.endDay);
    if (startIdx < 0 || endIdx < 0) {
      // Invalid day name — skip this entry
      continue;
    }

    // Cyclic range check: handles week wrap-around (e.g. friday–monday)
    let inRange = false;
    if (startIdx <= endIdx) {
      inRange = todayIdx >= startIdx && todayIdx <= endIdx;
    } else {
      // Wraps around Sunday: e.g. friday(5)–monday(1)
      inRange = todayIdx >= startIdx || todayIdx <= endIdx;
    }

    if (inRange) {
      return {
        userId: entry.userId,
        label: entry.label ?? entry.userId,
        reason: `on-call rotation (${entry.startDay}–${entry.endDay})`,
      };
    }
  }

  // No rotation entry matched today — use fallback
  if (config.fallback) {
    return { userId: config.fallback, label: config.fallback, reason: 'on-call fallback' };
  }

  return null;
}
