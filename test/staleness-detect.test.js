/**
 * Tests for staleness-detect.js pure exported functions.
 *
 * Strategy for avoiding side effects from main():
 *   Write a temporary doc-usage.json with an entry whose staleness score is
 *   well below the default 0.3 threshold. main() will run, skip the entry,
 *   and return cleanly — no Slack calls, no process.exit.
 *   Clean up the file after import.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import fc from 'fast-check';

const PROJECT_ROOT = path.resolve(import.meta.url.replace('file://', ''), '../..');
const USAGE_PATH = path.join(PROJECT_ROOT, 'doc-usage.json');
const USAGE_BACKUP_PATH = USAGE_PATH + '.test-bak';

// Pure function references — populated in before()
let parseThreshold;
let computeStalenessScore;
let isInCooldown;
let COOLDOWN_MS;

describe('staleness-detect', async () => {

  before(async () => {
    // Backup real doc-usage.json if it exists
    const hadUsageFile = fs.existsSync(USAGE_PATH);
    if (hadUsageFile) {
      fs.copyFileSync(USAGE_PATH, USAGE_BACKUP_PATH);
    }

    // Write a dummy usage file with a staleness score far below threshold
    // so main() processes the file but skips the entry and returns cleanly
    const dummyUsage = {
      'test-placeholder.md': {
        citedCount: 1000,   // high cite count → low score
        followUpCount: 0,
        correctionCount: 0,
        lastCited: new Date().toISOString(),
      }
    };
    fs.writeFileSync(USAGE_PATH, JSON.stringify(dummyUsage));

    // Import the module — main() runs and returns without Slack calls
    const mod = await import('../staleness-detect.js');
    parseThreshold = mod.parseThreshold;
    computeStalenessScore = mod.computeStalenessScore;
    isInCooldown = mod.isInCooldown;
    COOLDOWN_MS = mod.COOLDOWN_MS;
  });

  after(() => {
    // Restore or remove doc-usage.json
    if (fs.existsSync(USAGE_BACKUP_PATH)) {
      fs.copyFileSync(USAGE_BACKUP_PATH, USAGE_PATH);
      fs.unlinkSync(USAGE_BACKUP_PATH);
    } else if (fs.existsSync(USAGE_PATH)) {
      fs.unlinkSync(USAGE_PATH);
    }
  });

  // Feature: usage-staleness-and-correction-loop, Property 8: Staleness Score Formula
  // Validates: Requirements 3.1
  test('Property 8: Staleness Score Formula', () => {
    fc.assert(fc.property(
      fc.nat(),         // citedCount >= 0
      fc.nat(),         // followUpCount >= 0
      fc.nat(),         // correctionCount >= 0
      (citedCount, followUpCount, correctionCount) => {
        const expected = (followUpCount + 2 * correctionCount) / Math.max(citedCount, 1);
        const actual = computeStalenessScore({ citedCount, followUpCount, correctionCount });
        assert.equal(actual, expected,
          `computeStalenessScore({citedCount:${citedCount}, followUpCount:${followUpCount}, correctionCount:${correctionCount}}) ` +
          `expected ${expected}, got ${actual}`
        );
      }
    ), { numRuns: 100 });
  });

  test('Property 8 edge: citedCount=0 uses 1 as denominator', () => {
    fc.assert(fc.property(
      fc.nat(),  // followUpCount
      fc.nat(),  // correctionCount
      (followUpCount, correctionCount) => {
        const expected = followUpCount + 2 * correctionCount; // denominator is max(0,1)=1
        const actual = computeStalenessScore({ citedCount: 0, followUpCount, correctionCount });
        assert.equal(actual, expected);
      }
    ), { numRuns: 100 });
  });

  // Feature: usage-staleness-and-correction-loop, Property 9: STALENESS_THRESHOLD Parsing with Invalid Input Falls Back to 0.3
  // Validates: Requirements 3.2
  test('Property 9: STALENESS_THRESHOLD Parsing Falls Back to 0.3 for known invalid values', () => {
    const invalidInputs = [
      '',
      'abc',
      'NaN',
      'Infinity',
      '-Infinity',
      'undefined',
      'null',
      '   ',
      'not-a-number',
    ];

    for (const invalid of invalidInputs) {
      const result = parseThreshold(invalid);
      assert.equal(result, 0.3,
        `parseThreshold("${invalid}") should return 0.3, got ${result}`
      );
    }

    // undefined also falls back
    assert.equal(parseThreshold(undefined), 0.3);
  });

  test('Property 9: property-based — any non-finite-parsing string falls back to 0.3', () => {
    fc.assert(fc.property(
      fc.oneof(
        fc.constant(''),
        fc.constant('NaN'),
        fc.constant('Infinity'),
        fc.constant('-Infinity'),
        // Random strings that parseFloat won't produce a finite number from
        fc.string({ minLength: 1, maxLength: 10 }).filter(s => !Number.isFinite(parseFloat(s)))
      ),
      (invalidStr) => {
        const result = parseThreshold(invalidStr);
        assert.equal(result, 0.3,
          `parseThreshold("${invalidStr}") should return 0.3, got ${result}`
        );
      }
    ), { numRuns: 100 });
  });

  test('Property 9: valid finite number strings are parsed as numbers', () => {
    fc.assert(fc.property(
      fc.float({ min: Math.fround(0.01), max: Math.fround(1.0), noNaN: true, noDefaultInfinity: true }),
      (threshold) => {
        const str = threshold.toString();
        const result = parseThreshold(str);
        assert.ok(Number.isFinite(result), `Result should be finite for valid input "${str}"`);
        assert.equal(result, parseFloat(str));
      }
    ), { numRuns: 100 });
  });

  // Feature: usage-staleness-and-correction-loop, Property 10: 168-Hour Cooldown Suppresses Re-Notification
  // Validates: Requirements 3.5
  test('Property 10: timestamps WITHIN 168h window return true (in cooldown)', () => {
    fc.assert(fc.property(
      // msAgo is strictly less than COOLDOWN_MS (168h)
      fc.integer({ min: 0, max: 168 * 60 * 60 * 1000 - 1 }),
      (msAgo) => {
        const now = Date.now();
        const storedTimestamp = new Date(now - msAgo).toISOString();
        const result = isInCooldown(storedTimestamp, now);
        assert.equal(result, true,
          `isInCooldown should be true for timestamp ${msAgo}ms ago (within 168h window)`
        );
      }
    ), { numRuns: 100 });
  });

  test('Property 10: timestamps OUTSIDE 168h window return false (not in cooldown)', () => {
    fc.assert(fc.property(
      // msAgo is strictly greater than COOLDOWN_MS
      fc.integer({ min: 1, max: 30 * 24 * 60 * 60 * 1000 }),
      (extraMs) => {
        const now = Date.now();
        const msAgo = 168 * 60 * 60 * 1000 + extraMs;
        const storedTimestamp = new Date(now - msAgo).toISOString();
        const result = isInCooldown(storedTimestamp, now);
        assert.equal(result, false,
          `isInCooldown should be false for timestamp ${msAgo}ms ago (outside 168h window)`
        );
      }
    ), { numRuns: 100 });
  });

  test('Property 10: missing or empty timestamp is never in cooldown', () => {
    const now = Date.now();
    assert.equal(isInCooldown(undefined, now), false, 'undefined should not be in cooldown');
    assert.equal(isInCooldown('', now), false, 'empty string should not be in cooldown');
    assert.equal(isInCooldown(null, now), false, 'null should not be in cooldown');
  });

  test('COOLDOWN_MS constant equals exactly 168 hours in milliseconds', () => {
    assert.equal(COOLDOWN_MS, 168 * 60 * 60 * 1000, 'COOLDOWN_MS should be 168h in ms');
  });

});
