'use strict';

/* ==========================================================================
   Jade! — statistics math
   Pure functions over Store.data.days (only the `done` flags are read), so
   tests/stats.test.js can run them in Node. Dates are "YYYY-MM-DD" keys,
   months are "YYYY-MM". Percentages are fractions (0.58), not strings.
   ========================================================================== */

const Stats = (() => {
  // Keys are calendar dates, so do the arithmetic in UTC: no DST surprises
  const DAY_MS = 24 * 60 * 60 * 1000;
  const toTime = (key) => {
    const [y, m, d] = key.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  const fromTime = (t) => new Date(t).toISOString().slice(0, 10);

  function addDays(key, n) {
    return fromTime(toTime(key) + n * DAY_MS);
  }

  function monthOf(key) {
    return key.slice(0, 7);
  }

  function addMonths(month, n) {
    const [y, m] = month.split('-').map(Number);
    return fromTime(Date.UTC(y, m - 1 + n, 1)).slice(0, 7);
  }

  function monthEnd(month) {
    return addDays(`${addMonths(month, 1)}-01`, -1);
  }

  function mondayOf(key) {
    const weekday = new Date(toTime(key)).getUTCDay();
    return addDays(key, -((weekday + 6) % 7));
  }

  // Per habit: days done / days in the span. Total: all checks / all possible.
  function spanStats(days, ids, from, to) {
    const done = Object.fromEntries(ids.map((id) => [id, 0]));
    let length = 0;
    for (let key = from; key <= to; key = addDays(key, 1)) {
      length++;
      const day = days[key];
      if (!day || !day.done) continue;
      for (const id of ids) if (day.done[id]) done[id]++;
    }
    const byHabit = {};
    let checks = 0;
    for (const id of ids) {
      byHabit[id] = done[id] / length;
      checks += done[id];
    }
    return { byHabit, total: ids.length ? checks / (length * ids.length) : 0 };
  }

  // The whole month, future days included, except that the first tracked
  // month starts on the first tracked day. null before tracking started.
  function monthStats(days, ids, month, startKey) {
    const first = `${month}-01`;
    const last = monthEnd(month);
    if (startKey > last) return null;
    return spanStats(days, ids, startKey > first ? startKey : first, last);
  }

  // Always all 7 days (35 checks for 5 habits)
  function weekStats(days, ids, monday) {
    return spanStats(days, ids, monday, addDays(monday, 6));
  }

  // A week belongs to the month holding 4+ of its days, i.e. its Thursday's
  function weekMonth(monday) {
    return monthOf(addDays(monday, 3));
  }

  // Mondays from the first tracked week through the current one
  function weekStarts(startKey, todayKey) {
    const mondays = [];
    const last = mondayOf(todayKey);
    for (let m = mondayOf(startKey); m <= last; m = addDays(m, 7)) mondays.push(m);
    return mondays;
  }

  return { addDays, monthOf, addMonths, monthEnd, mondayOf, monthStats, weekStats, weekMonth, weekStarts };
})();

if (typeof module !== 'undefined') module.exports = Stats;
