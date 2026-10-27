'use strict';

// Run with: node --test tests/stats.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const Stats = require('../stats.js');

const IDS = ['sport', 'language', 'blog', 'design', 'smartass'];

// days({ '2026-10-26': ['sport', 'blog'] }) -> Store.data.days shape
function days(map) {
  const out = {};
  for (const [key, ids] of Object.entries(map)) {
    out[key] = { done: Object.fromEntries(ids.map((id) => [id, true])), notes: {} };
  }
  return out;
}

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test('radar: a habit counts against the whole month, future days included', () => {
  const d = days({ '2026-11-02': ['sport'], '2026-11-03': ['sport'], '2026-11-04': ['sport'] });
  const s = Stats.monthStats(d, IDS, '2026-11', '2026-10-26');
  close(s.byHabit.sport, 3 / 30);
  close(s.byHabit.language, 0);
});

test('radar: the first tracked month only counts from the first tracked day', () => {
  // Oct 26..31 = 6 days
  const d = days({ '2026-10-26': ['sport', 'language'], '2026-10-27': ['sport'] });
  const s = Stats.monthStats(d, IDS, '2026-10', '2026-10-26');
  close(s.byHabit.sport, 2 / 6);
  close(s.byHabit.language, 1 / 6);
  close(s.total, 3 / 30);
});

test('radar: months before tracking have no data (no dashed line)', () => {
  assert.equal(Stats.monthStats({}, IDS, '2026-09', '2026-10-26'), null);
});

test('month total = all done checks / all possible checks', () => {
  const d = days({ '2026-12-01': IDS, '2026-12-02': ['sport', 'blog'] });
  const s = Stats.monthStats(d, IDS, '2026-12', '2026-10-26');
  close(s.total, 7 / (31 * 5));
});

test('month total: February in a leap year has 29 days', () => {
  const d = days({ '2028-02-29': ['sport'] });
  const s = Stats.monthStats(d, IDS, '2028-02', '2026-10-26');
  close(s.byHabit.sport, 1 / 29);
});

test('week: All = done / 35, a habit = done / 7', () => {
  const d = days({
    '2026-10-26': ['sport', 'blog'],
    '2026-10-28': ['sport'],
    '2026-11-01': IDS,
    '2026-11-02': IDS, // next week, must not count
  });
  const s = Stats.weekStats(d, IDS, '2026-10-26');
  close(s.total, 8 / 35);
  close(s.byHabit.sport, 3 / 7);
  close(s.byHabit.blog, 2 / 7);
  close(s.byHabit.language, 1 / 7);
});

test('week: other days and habits outside the filter are ignored', () => {
  const d = days({ '2026-10-25': ['sport'], '2026-10-27': ['language'] });
  const s = Stats.weekStats(d, ['sport'], '2026-10-26');
  close(s.byHabit.sport, 0);
  close(s.total, 0);
});

test('cross-month week goes to the month holding 4+ of its days', () => {
  assert.equal(Stats.weekMonth('2026-10-26'), '2026-10'); // Oct 26..31 + Nov 1 -> 6 Oct days
  assert.equal(Stats.weekMonth('2026-11-30'), '2026-12'); // Nov 30 + Dec 1..6 -> 6 Dec days
  assert.equal(Stats.weekMonth('2026-09-28'), '2026-10'); // Sep 28..30 + Oct 1..4 -> 4 Oct days
  assert.equal(Stats.weekMonth('2026-12-28'), '2026-12'); // Dec 28..31 + Jan 1..3 -> 4 Dec days
  assert.equal(Stats.weekMonth('2027-12-27'), '2027-12'); // Dec 27..31 + Jan 1..2
  assert.equal(Stats.weekMonth('2028-12-25'), '2028-12'); // whole week in one month
});

test('weeks run from the first tracked week to the current one', () => {
  assert.deepEqual(Stats.weekStarts('2026-10-26', '2026-10-27'), ['2026-10-26']);
  assert.deepEqual(Stats.weekStarts('2026-10-28', '2026-11-09'), ['2026-10-26', '2026-11-02', '2026-11-09']);
  assert.equal(Stats.mondayOf('2026-11-01'), '2026-10-26'); // Sunday belongs to the week before
});

test('month helpers handle year boundaries', () => {
  assert.equal(Stats.addMonths('2026-12', 1), '2027-01');
  assert.equal(Stats.addMonths('2027-01', -1), '2026-12');
  assert.equal(Stats.monthEnd('2026-11'), '2026-11-30');
});
