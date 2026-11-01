'use strict';

// Run with: node --test tests/trackers.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../trackers.js');

test('duration crosses midnight', () => {
  assert.equal(T.duration('23:15', '07:30'), 8 * 60 + 15);
  assert.equal(T.duration('00:40', '08:10'), 7 * 60 + 30);
  assert.equal(T.duration('04:00', '17:00'), 13 * 60);
  assert.equal(T.duration('07:00', '07:00'), 0);
});

test('problem rejects zero and over 20h', () => {
  assert.equal(T.problem('23:00', '07:00'), null);
  assert.ok(T.problem('07:00', '07:00'));
  assert.ok(T.problem('08:00', '05:00')); // 21h
  assert.equal(T.problem('08:00', '04:00'), null); // exactly 20h
});

test('span is measured from 18:00', () => {
  assert.deepEqual(T.span('23:15', '07:30'), { start: 315, end: 810 });
  assert.deepEqual(T.span('04:00', '17:00'), { start: 600, end: 1380 });
  assert.deepEqual(T.span('18:00', '02:00'), { start: 0, end: 480 });
  // Bedtime just before 18:00 starts above the top, not past the bottom
  assert.deepEqual(T.span('17:30', '01:00'), { start: -30, end: 420 });
});

test('formatting', () => {
  assert.equal(T.formatDuration(495), '8h 15m');
  assert.equal(T.formatDuration(480), '8h');
  assert.equal(T.formatDuration(399.6), '6h 40m');
  assert.equal(T.formatTime('07:30'), '7:30');
  assert.equal(T.formatTime('00:05'), '0:05');
  assert.equal(T.formatTime('23:15'), '23:15');
});

test('monthAverage only counts that month', () => {
  const sleep = {
    '2026-11-01': { bed: '23:00', wake: '07:00' },
    '2026-11-02': { bed: '01:00', wake: '06:00' },
    '2026-10-31': { bed: '20:00', wake: '10:00' },
  };
  assert.equal(T.monthAverage(sleep, '2026-11'), 390);
  assert.equal(T.monthAverage(sleep, '2026-12'), null);
});

test('daysInMonth', () => {
  assert.equal(T.daysInMonth('2026-11'), 30);
  assert.equal(T.daysInMonth('2026-02'), 28);
  assert.equal(T.daysInMonth('2028-02'), 29);
  assert.equal(T.daysInMonth('2026-12'), 31);
});
