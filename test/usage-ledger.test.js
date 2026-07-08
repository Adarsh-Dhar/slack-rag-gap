import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import fc from 'fast-check';
import { updateUsageLedger } from '../agent/usage-ledger.js';

function tmpLedgerPath() {
  return path.join(os.tmpdir(), `test-ledger-${randomUUID()}.json`);
}

describe('usage-ledger', () => {

  // Feature: usage-staleness-and-correction-loop, Property 1: Usage Ledger Round-Trip
  // Validates: Requirements 1.2, 7.2
  test('Property 1: Usage Ledger Round-Trip', () => {
    fc.assert(fc.property(
      fc.record({
        docName: fc.string({ minLength: 1, maxLength: 40 }).map(s => s.replace(/[^a-z0-9]/gi, 'x') || 'doc').map(s => s + '.md'),
        citedCount: fc.nat(),
        followUpCount: fc.nat(),
        correctionCount: fc.nat(),
        lastCited: fc.date({ min: new Date(0), max: new Date('2099-01-01') }).map(d => d.toISOString()),
      }),
      (entry) => {
        const ledger = {
          [entry.docName]: {
            citedCount: entry.citedCount,
            followUpCount: entry.followUpCount,
            correctionCount: entry.correctionCount,
            lastCited: entry.lastCited,
          }
        };
        const tmpPath = tmpLedgerPath();
        try {
          fs.writeFileSync(tmpPath, JSON.stringify(ledger, null, 2));
          const readBack = JSON.parse(fs.readFileSync(tmpPath, 'utf-8'));
          assert.deepEqual(ledger, readBack);
        } finally {
          if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
        }
      }
    ), { numRuns: 100 });
  });

  // Feature: usage-staleness-and-correction-loop, Property 2: Citation Increments All Returned Sources
  // Validates: Requirements 1.1, 1.4
  test('Property 2: Citation Increments All Returned Sources', () => {
    fc.assert(fc.property(
      fc.array(
        fc.string({ minLength: 1, maxLength: 30 }).map(s => (s.replace(/[^a-z0-9]/gi, 'x') || 'doc') + '.md'),
        { minLength: 1, maxLength: 10 }
      ).map(arr => [...new Set(arr)]).filter(arr => arr.length > 0),
      fc.dictionary(
        fc.string({ minLength: 1, maxLength: 30 }).map(s => (s.replace(/[^a-z0-9]/gi, 'x') || 'other') + '.md'),
        fc.record({
          citedCount: fc.nat(),
          followUpCount: fc.nat(),
          correctionCount: fc.nat(),
          lastCited: fc.string(),
        }).map(v => ({ citedCount: v.citedCount, followUpCount: v.followUpCount, correctionCount: v.correctionCount, lastCited: v.lastCited })),
        { minKeys: 0, maxKeys: 5 }
      ),
      (sources, initialOtherEntries) => {
        const tmpPath = tmpLedgerPath();
        try {
          // Build initial ledger: only other entries (not the sources being tested)
          // Use JSON round-trip to strip null prototypes from fast-check generated objects
          const initialLedger = JSON.parse(JSON.stringify(
            Object.fromEntries(
              Object.entries(initialOtherEntries).filter(([k]) => !sources.includes(k))
            )
          ));

          if (Object.keys(initialLedger).length > 0) {
            fs.writeFileSync(tmpPath, JSON.stringify(initialLedger, null, 2));
          }

          updateUsageLedger(sources, 'citedCount', tmpPath);

          const afterLedger = JSON.parse(fs.readFileSync(tmpPath, 'utf-8'));

          // Every source must have citedCount === 1
          for (const src of sources) {
            assert.equal(afterLedger[src].citedCount, 1, `Expected citedCount=1 for ${src}`);
          }

          // All other entries that were in initialLedger must be unchanged
          for (const [k, v] of Object.entries(initialLedger)) {
            assert.deepEqual(afterLedger[k], v, `Entry for ${k} should be unchanged`);
          }
        } finally {
          if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
          const tmp2 = tmpPath + '.tmp';
          if (fs.existsSync(tmp2)) fs.unlinkSync(tmp2);
        }
      }
    ), { numRuns: 100 });
  });

  // Feature: usage-staleness-and-correction-loop, Property 3: Malformed Ledger Recovery
  // Validates: Requirements 7.1, 7.3
  test('Property 3: Malformed Ledger Recovery', () => {
    fc.assert(fc.property(
      // Any string that is NOT valid JSON
      fc.string({ minLength: 1 }).filter(s => {
        try { JSON.parse(s); return false; } catch { return true; }
      }),
      fc.array(
        fc.string({ minLength: 1, maxLength: 20 }).map(s => (s.replace(/[^a-z0-9]/gi, 'x') || 'doc') + '.md'),
        { minLength: 1, maxLength: 5 }
      ).map(arr => [...new Set(arr)]).filter(arr => arr.length > 0),
      (malformedContent, sources) => {
        const tmpPath = tmpLedgerPath();
        try {
          // Write malformed JSON to ledger file
          fs.writeFileSync(tmpPath, malformedContent);

          // Must not throw
          assert.doesNotThrow(() => {
            updateUsageLedger(sources, 'citedCount', tmpPath);
          });

          // File must be readable after recovery
          const content = fs.readFileSync(tmpPath, 'utf-8');
          const recovered = JSON.parse(content); // must not throw

          // Must contain only the new entries (the sources we just wrote)
          for (const src of sources) {
            assert.ok(src in recovered, `Recovered ledger must contain ${src}`);
            assert.equal(recovered[src].citedCount, 1);
          }
        } finally {
          if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
          const tmp2 = tmpPath + '.tmp';
          if (fs.existsSync(tmp2)) fs.unlinkSync(tmp2);
        }
      }
    ), { numRuns: 100 });
  });

  // Unit test: missing file is created on first write (Requirement 1.3)
  test('missing ledger file is created on first write', () => {
    const tmpPath = tmpLedgerPath();
    // Ensure file does not exist
    assert.equal(fs.existsSync(tmpPath), false);
    try {
      updateUsageLedger(['newdoc.md'], 'citedCount', tmpPath);
      assert.equal(fs.existsSync(tmpPath), true);
      const ledger = JSON.parse(fs.readFileSync(tmpPath, 'utf-8'));
      assert.equal(ledger['newdoc.md'].citedCount, 1);
    } finally {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      const tmp2 = tmpPath + '.tmp';
      if (fs.existsSync(tmp2)) fs.unlinkSync(tmp2);
    }
  });

});
