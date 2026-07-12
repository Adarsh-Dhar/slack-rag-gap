import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { getOnCallPerson } from '../agent/on-call.js';

const ON_CALL_PATH = path.join(process.cwd(), 'on-call.json');
let originalOnCallExists = false;
let originalOnCallContent = '';

describe('on-call / getOnCallPerson', () => {
  beforeEach(() => {
    originalOnCallExists = fs.existsSync(ON_CALL_PATH);
    if (originalOnCallExists) {
      originalOnCallContent = fs.readFileSync(ON_CALL_PATH, 'utf-8');
    }
  });

  afterEach(() => {
    // Restore original state
    if (originalOnCallExists) {
      fs.writeFileSync(ON_CALL_PATH, originalOnCallContent);
    } else if (fs.existsSync(ON_CALL_PATH)) {
      fs.unlinkSync(ON_CALL_PATH);
    }
  });

  test('returns null when no on-call.json exists', () => {
    if (fs.existsSync(ON_CALL_PATH)) fs.unlinkSync(ON_CALL_PATH);
    const result = getOnCallPerson();
    assert.equal(result, null);
  });

  test('returns on-call person for current day rotation', () => {
    const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const today = days[new Date().getDay()];
    const dayIdx = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
    const todayNum = dayIdx[today];

    // Create a rotation where today is covered
    const rotation = [
      { userId: 'U111', label: 'Alice', startDay: 'monday', endDay: 'sunday' },
    ];

    fs.writeFileSync(ON_CALL_PATH, JSON.stringify({ rotation }));

    const result = getOnCallPerson();
    assert.ok(result, `Should return an on-call person for ${today}`);
    assert.equal(result.userId, 'U111');
  });

  test('returns fallback when no rotation entry matches', () => {
    // Set a rotation for a different day than today
    const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const today = days[new Date().getDay()];
    const dayIdx = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
    const todayNum = dayIdx[today];

    // Pick a day that is NOT today
    const otherDay = days[(todayNum + 3) % 7];

    fs.writeFileSync(ON_CALL_PATH, JSON.stringify({
      rotation: [
        { userId: 'U111', label: 'Alice', startDay: otherDay, endDay: otherDay },
      ],
      fallback: 'U999',
    }));

    const result = getOnCallPerson();
    assert.ok(result, 'Should return fallback');
    assert.equal(result.userId, 'U999');
    assert.ok(result.reason.includes('fallback'));
  });

  test('applies entry with no day range to every day', () => {
    fs.writeFileSync(ON_CALL_PATH, JSON.stringify({
      rotation: [
        { userId: 'U777', label: 'Always On-Call' },
      ],
    }));

    const result = getOnCallPerson();
    assert.ok(result, 'Should return the always-on-call person');
    assert.equal(result.userId, 'U777');
  });
});
