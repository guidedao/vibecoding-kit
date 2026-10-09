import { test } from 'node:test';
import assert from 'node:assert/strict';
import { currentStreak } from '../src/streak.js';

test('пустой список — серия 0', () => {
  assert.equal(currentStreak([], '2026-10-03'), 0);
});

test('сегодня и вчера — серия 2', () => {
  assert.equal(currentStreak(['2026-10-02', '2026-10-03'], '2026-10-03'), 2);
});
