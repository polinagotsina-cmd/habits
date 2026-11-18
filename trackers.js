'use strict';

/* ==========================================================================
   Jade! — sleep tracker math
   Pure functions, so tests/trackers.test.js can run them in Node. Times are
   "HH:MM" (24h), dates "YYYY-MM-DD", months "YYYY-MM". A night belongs to
   the day of waking up; the chart runs from 18:00 (top) to 18:00 the next
   day (bottom), measured in minutes from its top. An open night has a
   bedtime but no wake-up yet (wake = null).
   ========================================================================== */

const Trackers = (() => {
  const DAY_MIN = 24 * 60;
  const CHART_START = 18 * 60; // 18:00 at the top of the chart
  const MAX_SLEEP = 20 * 60;
  const OPEN_LENGTH = 6.5 * 60; // an open night's bar: solid, then fading out

  // "2026-11-07" + 1 -> "2026-11-08"
  function addDays(key, n) {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
  }

  const dayNumber = (key) => Date.parse(`${key}T00:00:00Z`) / (DAY_MIN * 60000);

  const toMinutes = (time) => {
    const [h, m] = time.split(':').map(Number);
    return h * 60 + m;
  };

  // Wake earlier than bedtime means the next day. Equal times: 0.
  function duration(bed, wake) {
    const d = toMinutes(wake) - toMinutes(bed);
    return d < 0 ? d + DAY_MIN : d;
  }

  // A message when the times can't be a night's sleep, else null
  function problem(bed, wake) {
    const d = duration(bed, wake);
    if (d === 0) return 'Bedtime and wake up are the same';
    if (d > MAX_SLEEP) return 'Over 20h? Check the times';
    return null;
  }

  // Where the bar goes: minutes from the chart's top. Normally within
  // 0..1440; a bedtime just before 18:00 starts above the top instead of
  // running off the bottom. An open night (no wake) is OPEN_LENGTH long.
  function span(bed, wake) {
    const length = wake ? duration(bed, wake) : OPEN_LENGTH;
    let start = (toMinutes(bed) - CHART_START + DAY_MIN) % DAY_MIN;
    if (start + length > DAY_MIN) start -= DAY_MIN;
    return { start, end: start + length };
  }

  // "8h 15m", "8h"
  function formatDuration(minutes) {
    const total = Math.round(minutes);
    const h = Math.floor(total / 60);
    const m = total % 60;
    return m ? `${h}h ${m}m` : `${h}h`;
  }

  // "07:30" -> "7:30"
  function formatTime(time) {
    return time.replace(/^0(\d)/, '$1');
  }

  // Average length of the nights logged in a month, or null
  function monthAverage(sleep, month) {
    let sum = 0;
    let n = 0;
    for (const [key, night] of Object.entries(sleep)) {
      if (key.slice(0, 7) !== month || !night.wake) continue;
      sum += duration(night.bed, night.wake);
      n += 1;
    }
    return n ? sum / n : null;
  }

  function daysInMonth(month) {
    const [y, m] = month.split('-').map(Number);
    return new Date(Date.UTC(y, m, 0)).getUTCDate();
  }

  // The night a bedtime saved on its own belongs to. The bedtime is taken
  // as its occurrence closest to now (today at time `now`); from 18:00 on
  // it starts the next day's night: 23:15 on Nov 7 -> Nov 8, 01:30 on
  // Nov 8 -> Nov 8, and 23:50 typed at 00:30 on Nov 8 -> Nov 8 as well.
  function nightDay(bed, today, now) {
    const b = toMinutes(bed);
    const n = toMinutes(now);
    let offset = 0;
    if (b - n > DAY_MIN / 2) offset = -1;
    else if (n - b > DAY_MIN / 2) offset = 1;
    if (b >= CHART_START) offset += 1;
    return addDays(today, offset);
  }

  // Minutes from an open night's bedtime to now (negative if still ahead)
  function openFor(day, bed, today, now) {
    const b = toMinutes(bed);
    const bedDay = b >= CHART_START ? addDays(day, -1) : day;
    return (dayNumber(today) - dayNumber(bedDay)) * DAY_MIN + toMinutes(now) - b;
  }

  // A day's mood entries in order: by time (entries without one first),
  // then by id
  function sortMoods(entries) {
    return entries.sort((a, b) =>
      (a.time || '').localeCompare(b.time || '') || a.id.localeCompare(b.id));
  }

  return { DAY_MIN, CHART_START, toMinutes, addDays, nightDay, openFor, sortMoods, duration, problem, span, formatDuration, formatTime, monthAverage, daysInMonth };
})();

if (typeof module !== 'undefined') module.exports = Trackers;
