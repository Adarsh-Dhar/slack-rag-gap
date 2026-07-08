/**
 * Tests for staleness-detect.js pure exported functions.
 *
 * main() no longer runs on import (guarded by isMain check), so we can
 * import directly with no file-system setup or teardown needed.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import {
  parseThreshold,
  computeStalenessScore,
  isInCooldown,
  COOLDOWN_MS,
} from '../staleness-detect.js';

describe('staleness-detect', () => {

  // Feature: usage-staleness-and-correction-loop, Property 8: Staleness Score Formula
  // Validates: Requirements 3.1
  test('Property 8: Staleness Score Formula', () => {
    fc.assert(fc.property(
      fc.nat(),
      fc.nat(),
      fc.nat(),
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
      fc.nat(),
      fc.nat(),
      (followUpCount, correctionCount) => {
        const expected = followUpCount + 2 * correctionCount;
        const actual = computeStalenessScore({ citedCount: 0, followUpCount, correctionCount });
        assert.equal(actual, expected);
      }
    ), { numRuns: 100 });
  });

  // Feature: usage-staleness-and-correction-loop, Property 9: STALENESS_THRESHOLD Parsing
  // Validates: Requirements 3.2
  test('Property 9: STALENESS_THRESHOLD Parsing Falls Back to 0.3 for known invalid values', () => {
    const invalidInputs = ['', 'abc', 'NaN', 'Infinity', '-Infinity', 'undefined', 'null', '   ', 'not-a-number'];
    for (const invalid of invalidInputs) {
      assert.equal(parseThreshold(invalid), 0.3, `parseThreshold("${invalid}") should return 0.3`);
    }
    assert.equal(parseThreshold(undefined), 0.3);
  });

  test('Property 9: property-based — any non-finite-parsing string falls back to 0.3', () => {
    fc.assert(fc.property(
      fc.oneof(
        fc.constant(''),
        fc.constant('NaN'),
        fc.constant('Infinity'),
        fc.constant('-Infinity'),
        fc.string({ minLength: 1, maxLength: 10 }).filter(s => !Number.isFinite(parseFloat(s)))
      ),
      (invalidStr) => {
        assert.equal(parseThreshold(invalidStr), 0.3,
          `parseThreshold("${invalidStr}") should return 0.3`
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

  // Feature: usage-staleness-and-correction-loop, Property 10: 168-Hour Cooldown
  // Validates: Requirements 3.5
  test('Property 10: timestamps WITHIN 168h window return true (in cooldown)', () => {
    fc.assert(fc.property(
      fc.integer({ min: 0, max: 168 * 60 * 60 * 1000 - 1 }),
      (msAgo) => {
        const now = Date.now();
        const storedTimestamp = new Date(now - msAgo).toISOString();
        assert.equal(isInCooldown(storedTimestamp, now), true,
          `isInCooldown should be true for timestamp ${msAgo}ms ago (within 168h window)`
        );
      }
    ), { numRuns: 100 });
  });

  test('Property 10: timestamps OUTSIDE 168h window return false (not in cooldown)', () => {
    fc.assert(fc.property(
      fc.integer({ min: 1, max: 30 * 24 * 60 * 60 * 1000 }),
      (extraMs) => {
        const now = Date.now();
        const msAgo = 168 * 60 * 60 * 1000 + extraMs;
        const storedTimestamp = new Date(now - msAgo).toISOString();
        assert.equal(isInCooldown(storedTimestamp, now), false,
          `isInCooldown should be false for timestamp ${msAgo}ms ago (outside 168h window)`
        );
      }
    ), { numRuns: 100 });
  });

  test('Property 10: missing or empty timestamp is never in cooldown', () => {
    const now = Date.now();
    assert.equal(isInCooldown(undefined, now), false);
    assert.equal(isInCooldown('', now), false);
    assert.equal(isInCooldown(null, now), false);
  });

  test('COOLDOWN_MS constant equals exactly 168 hours in milliseconds', () => {
    assert.equal(COOLDOWN_MS, 168 * 60 * 60 * 1000);
  });

});
