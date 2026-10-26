'use strict';

/* ==========================================================================
   Habits — app logic
   Data lives in localStorage under STORAGE_KEY:
     { version: 1, days: { "YYYY-MM-DD": { done: { id: true }, notes: { id: "text" } } } }
   ========================================================================== */

// Hardcoded for now; editing the list comes later. Ids are what get stored.
const HABITS = [
  { id: 'sport', name: 'Sport' },
  { id: 'language', name: 'Language' },
  { id: 'blog', name: 'Blog/Clients' },
  { id: 'design', name: 'Design/Code' },
  { id: 'smartass', name: 'Smartass' },
];

const STORAGE_KEY = 'habits.v1';
const WELCOME_MS = 1500;
const LONG_PRESS_MS = 500;
const LONG_PRESS_MOVE_PX = 10;
const COMPLETE_DELAY_MS = 400; // time to see the checkmark before the card leaves

// Card exit/enter animation
const EXIT_MS = 600; // fade, desaturate, shrink and drift away
const FLIP_MS = 500; // cards below slide into place
const FLIP_STAGGER_MS = 30; // per following card
const FLIP_OVERLAP_MS = 150; // slide starts this long before the exit ends
const ENTER_DELAY_MS = 250; // returning card fades in after room starts opening
const EASE_OUT = 'cubic-bezier(0.22, 1, 0.36, 1)';
const GONE_TRANSFORM = 'translate(12px, -10px) scale(0.9)';
const GONE_BACKGROUND = 'rgba(238, 238, 238, 0)'; // yellow fades toward transparent grey

const WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

const CHECK_SVG =
  '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6.2 5 8.6 9.5 3.6" ' +
  'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const $ = (sel) => document.querySelector(sel);

/* ---------- Dates (always local time) ---------- */

const pad = (n) => String(n).padStart(2, '0');

function toKey(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function fromKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function addDays(key, n) {
  const d = fromKey(key);
  d.setDate(d.getDate() + n);
  return toKey(d);
}

// Monday..Sunday of the week containing `key`
function weekKeys(key) {
  const mondayOffset = (fromKey(key).getDay() + 6) % 7;
  const monday = addDays(key, -mondayOffset);
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}

// "MON, 26 OCT"
function formatHeading(key) {
  const d = fromKey(key);
  return `${WEEKDAYS[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

// For testing: ?today=YYYY-MM-DD pretends that date is today.
const TODAY_OVERRIDE = (() => {
  const v = new URLSearchParams(location.search).get('today');
  return /^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : null;
})();

function todayKey() {
  return TODAY_OVERRIDE || toKey(new Date());
}

/* ---------- Storage ---------- */

const Store = {
  data: null,

  load() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (parsed && typeof parsed.days === 'object') {
        this.data = parsed;
        return;
      }
    } catch (e) { /* fall through to empty data */ }
    this.data = { version: 1, days: {} };
  },

  save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data));
    } catch (e) { /* storage full or unavailable */ }
  },

  day(key, create = false) {
    let day = this.data.days[key];
    if (!day && create) {
      day = this.data.days[key] = { done: {}, notes: {} };
    }
    return day;
  },

  // Drop empty day records so storage only holds real data
  prune(key) {
    const day = this.data.days[key];
    if (day && !Object.keys(day.done).length && !Object.keys(day.notes).length) {
      delete this.data.days[key];
    }
  },

  isDone(key, id) {
    const day = this.day(key);
    return !!(day && day.done[id]);
  },

  setDone(key, id, done) {
    const day = this.day(key, true);
    if (done) day.done[id] = true;
    else delete day.done[id];
    this.prune(key);
    this.save();
  },

  earliestKey() {
    let min = null;
    for (const k of Object.keys(this.data.days)) if (min === null || k < min) min = k;
    return min;
  },

  // A day's own note wins (an empty string means "cleared on that day").
  // Otherwise the note carries over from the previous day — unless the habit
  // was done on that previous day, which ends the note.
  getNote(key, id) {
    const earliest = this.earliestKey();
    let k = key;
    while (earliest !== null && k >= earliest) {
      const day = this.day(k);
      if (day && Object.prototype.hasOwnProperty.call(day.notes, id)) return day.notes[id];
      const prev = addDays(k, -1);
      if (this.isDone(prev, id)) return '';
      k = prev;
    }
    return '';
  },

  setNote(key, id, text) {
    const day = this.day(key, true);
    delete day.notes[id];
    // Only store an own note if it differs from what would carry over
    if (this.getNote(key, id) !== text) day.notes[id] = text;
    this.prune(key);
    this.save();
  },
};

/* ---------- State & elements ---------- */

let currentDay = null; // the "YYYY-MM-DD" currently rendered

const els = {
  welcome: $('#welcome'),
  welcomeTitle: $('.welcome__title'),
  heading: $('#today-heading'),
  list: $('#today-list'),
  allDone: $('#all-done'),
  week: $('.week'),
  grid: $('#week-grid'),
  weekTotal: $('#week-total'),
};

/* ---------- Welcome screen ---------- */

function initWelcome() {
  let timer = null;
  const hide = () => {
    clearTimeout(timer);
    els.welcome.classList.add('is-hidden');
  };
  timer = setTimeout(hide, WELCOME_MS);
  els.welcome.addEventListener('click', (e) => {
    e.preventDefault();
    hide();
  });
}

/* ---------- Today list ---------- */

// animate: false rebuilds the list instantly (launch, day change);
// true diffs it so cards leave and come back smoothly (week grid taps).
function renderToday({ animate = false } = {}) {
  els.heading.textContent = formatHeading(currentDay);
  const wanted = HABITS.filter((h) => !Store.isDone(currentDay, h.id));

  if (!animate) {
    els.list.replaceChildren(...wanted.map(createCard));
    updateAllDone();
    return;
  }

  const existing = new Map();
  for (const li of els.list.children) {
    if (!li._leaving) existing.set(li.dataset.id, li);
  }

  for (const [id, li] of existing) {
    if (!wanted.some((h) => h.id === id)) leaveCard(li);
  }

  // Insert returning cards in one FLIP so everything below slides down
  // to make room, then fade the new cards in.
  const fresh = [];
  flip(() => {
    let prev = null;
    for (const habit of wanted) {
      let li = existing.get(habit.id);
      if (li) {
        // Unchecked (via the grid) while still showing its checkmark
        if (li.classList.contains('is-done')) {
          clearTimeout(li._leaveTimer);
          li.classList.remove('is-done');
        }
        if (!li.querySelector('.habit__input')) renderNote(li, habit);
      } else {
        li = createCard(habit);
        if (prev) prev.after(li);
        else els.list.prepend(li);
        fresh.push(li);
      }
      prev = li;
    }
    updateAllDone(true);
  });
  fresh.forEach((li) => fadeIn(li, ENTER_DELAY_MS));
}

// With animate, call this inside flip() so the section below slides once.
// Cards already taken out of the flow (fading ghosts) don't count.
function updateAllDone(animate = false) {
  const el = els.allDone;
  const show = ![...els.list.children].some((li) => !li._detached);
  const shown = !el.hidden && !el._leaving;
  if (show === shown) return;
  resetAllDone();
  if (!animate) {
    el.hidden = !show;
  } else if (show) {
    el.hidden = false;
    fadeIn(el, FLIP_OVERLAP_MS);
  } else {
    el._leaving = true;
    detach(el);
    fadeOut(el).then(() => {
      if (el._leaving) {
        resetAllDone();
        el.hidden = true;
      }
    });
  }
}

function resetAllDone() {
  const el = els.allDone;
  el.getAnimations().forEach((a) => a.cancel());
  el.removeAttribute('style');
  el._leaving = false;
  el._detached = false;
}

/* ---------- Enter / leave animations ----------
   Leave: the card loses its colour, fades, shrinks and drifts up-right.
   ~150ms before it's fully gone it's taken out of the layout (it keeps
   fading as an absolutely positioned ghost) and everything below slides up
   with FLIP: measure, change the DOM, measure again, then animate a
   transform from the old position back to 0. Only transform/opacity animate.
   Enter: the cards below slide down (FLIP), then the card fades in.
   Always the full animation: the OS reduced-motion setting is deliberately
   ignored (personal app). */

// The "visible" and "gone" looks; cards also fade their yellow to grey
function lookFrames(el) {
  const shown = { opacity: 1, transform: 'none', filter: 'grayscale(0)' };
  const gone = { opacity: 0, transform: GONE_TRANSFORM, filter: 'grayscale(1)' };
  if (el.classList.contains('habit')) {
    shown.backgroundColor = getComputedStyle(el).backgroundColor;
    gone.backgroundColor = GONE_BACKGROUND;
  }
  return { shown, gone };
}

function fadeOut(el) {
  const { shown, gone } = lookFrames(el);
  return el.animate([shown, gone], { duration: EXIT_MS, easing: EASE_OUT, fill: 'forwards' }).finished;
}

// The backwards fill applies the hidden look immediately, during the delay
function fadeIn(el, delay) {
  const { shown, gone } = lookFrames(el);
  return el.animate([gone, shown], { duration: EXIT_MS, delay, easing: EASE_OUT, fill: 'backwards' }).finished;
}

// Take an element out of the flow without moving it visually
function detach(el) {
  el._detached = true;
  const { offsetTop, offsetLeft, offsetWidth } = el;
  Object.assign(el.style, {
    position: 'absolute',
    top: `${offsetTop}px`,
    left: `${offsetLeft}px`,
    width: `${offsetWidth}px`,
    margin: '0',
    pointerEvents: 'none',
  });
}

// Everything that can shift when the Today list changes, top to bottom
function flipTargets() {
  const targets = [...els.list.children].filter((li) => !li._leaving);
  if (!els.allDone.hidden && !els.allDone._leaving) targets.push(els.allDone);
  targets.push(els.week);
  return targets;
}

function flip(mutate) {
  const before = new Map();
  for (const el of flipTargets()) {
    before.set(el, el.getBoundingClientRect().top); // visual position, mid-slide included
    if (el._flip) el._flip.cancel();
  }

  mutate();

  let moved = 0;
  for (const el of flipTargets()) {
    if (!before.has(el)) continue; // newly inserted: fades in instead
    const dy = before.get(el) - el.getBoundingClientRect().top;
    if (Math.abs(dy) < 0.5) continue;
    // Backwards fill puts the element back at its old spot in this same
    // frame, so nothing visibly moves before the slide starts.
    el._flip = el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], {
      duration: FLIP_MS, delay: moved * FLIP_STAGGER_MS, easing: EASE_OUT, fill: 'backwards',
    });
    moved++;
  }
}

function leaveCard(li) {
  if (li._leaving) return;
  li._leaving = true;
  clearTimeout(li._leaveTimer);
  const faded = fadeOut(li);
  const slideAt = EXIT_MS - FLIP_OVERLAP_MS;
  setTimeout(() => {
    if (!li.isConnected) return; // list was rebuilt meanwhile (day change)
    // One layout change: the card leaves the flow and, if it was the last
    // one, "All done" takes its place, so the week section moves only once.
    flip(() => {
      detach(li);
      updateAllDone(true);
    });
    faded.then(() => li.remove());
  }, slideAt);
}

function createCard(habit) {
  const li = document.createElement('li');
  li.className = 'habit';
  li.dataset.id = habit.id;
  li.innerHTML = `
    <div class="habit__row">
      <button class="check" type="button" aria-label="Mark ${habit.name} done">${CHECK_SVG}</button>
      <div class="habit__name"></div>
    </div>
    <div class="habit__note"></div>`;
  li.querySelector('.habit__name').textContent = habit.name;
  renderNote(li, habit);
  attachCardGestures(li, habit);
  return li;
}

function renderNote(li, habit) {
  const noteEl = li.querySelector('.habit__note');
  const note = Store.getNote(currentDay, habit.id);
  noteEl.textContent = note;
  noteEl.hidden = !note;
}

// Tap on the circle = complete. Long press anywhere on the card = edit note.
// The two never overlap: a fired long press swallows the following click.
function attachCardGestures(li, habit) {
  let pressTimer = null;
  let longPressed = false;
  let startX = 0;
  let startY = 0;

  const cancelPress = () => {
    clearTimeout(pressTimer);
    pressTimer = null;
    li.classList.remove('is-pressing');
  };

  li.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.habit__input')) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    longPressed = false;
    startX = e.clientX;
    startY = e.clientY;
    cancelPress();
    li.classList.add('is-pressing');
    pressTimer = setTimeout(() => {
      pressTimer = null;
      longPressed = true;
      li.classList.remove('is-pressing');
      openNoteEditor(li, habit);
    }, LONG_PRESS_MS);
  });

  li.addEventListener('pointermove', (e) => {
    if (pressTimer && Math.hypot(e.clientX - startX, e.clientY - startY) > LONG_PRESS_MOVE_PX) {
      cancelPress();
    }
  });

  li.addEventListener('pointerup', () => {
    cancelPress();
    if (longPressed) focusNoteEditor(li);
  });
  li.addEventListener('pointercancel', cancelPress);
  li.addEventListener('pointerleave', cancelPress);

  // iOS only shows the keyboard when focus() runs inside a user gesture,
  // so focus the editor on the touchend that finishes the long press.
  li.addEventListener('touchend', (e) => {
    if (!longPressed) return;
    e.preventDefault(); // also suppresses the synthetic click
    focusNoteEditor(li);
  }, { passive: false });

  li.addEventListener('click', (e) => {
    if (longPressed) {
      longPressed = false;
      return;
    }
    if (e.target.closest('.check')) toggleCard(li, habit);
  });

  li.addEventListener('contextmenu', (e) => e.preventDefault());
}

function toggleCard(li, habit) {
  if (li._leaving) return;

  // Tapping again within the delay undoes the check
  if (li.classList.contains('is-done')) {
    clearTimeout(li._leaveTimer);
    li.classList.remove('is-done');
    Store.setDone(currentDay, habit.id, false);
    renderWeek();
    return;
  }

  Store.setDone(currentDay, habit.id, true);
  li.classList.add('is-done');
  li.querySelector('.check').setAttribute('aria-label', `Undo ${habit.name}`);
  renderWeek();
  li._leaveTimer = setTimeout(() => leaveCard(li), COMPLETE_DELAY_MS);
}

/* ---------- Note editor ---------- */

function openNoteEditor(li, habit) {
  if (li.querySelector('.habit__input')) return;
  const day = currentDay;
  const noteEl = li.querySelector('.habit__note');

  const input = document.createElement('input');
  input.className = 'habit__input';
  input.type = 'text';
  input.placeholder = 'Add a note';
  input.value = Store.getNote(day, habit.id);
  input.setAttribute('enterkeyhint', 'done');
  input.setAttribute('autocomplete', 'off');
  input.setAttribute('aria-label', `Note for ${habit.name}`);

  noteEl.hidden = true;
  li.appendChild(input);
  input.focus(); // works on desktop; on iOS see the touchend handler

  // Enter/Escape close the editor directly rather than relying on blur,
  // which some browsers skip when the window isn't focused.
  let closed = false;
  const close = (save) => {
    if (closed) return;
    closed = true;
    if (save) Store.setNote(day, habit.id, input.value.trim());
    input.remove(); // may fire blur; `closed` makes that a no-op
    renderNote(li, habit);
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      close(true);
    } else if (e.key === 'Escape') {
      close(false);
    }
  });
  input.addEventListener('blur', () => close(true));
}

function focusNoteEditor(li) {
  const input = li.querySelector('.habit__input');
  if (input && document.activeElement !== input) {
    input.focus();
    const end = input.value.length;
    input.setSelectionRange(end, end);
  }
}

/* ---------- Current week grid ---------- */

function renderWeek() {
  const days = weekKeys(currentDay);
  const todayCol = days.indexOf(currentDay);
  const nodes = [];
  let total = 0;
  const perDay = new Array(7).fill(0);

  HABITS.forEach((habit, r) => {
    const row = r + 1;
    nodes.push(gridItem('div', 'week-grid__label', row, 1, habit.name));

    let doneCount = 0;
    days.forEach((day, c) => {
      const done = Store.isDone(day, habit.id);
      if (done) {
        doneCount++;
        perDay[c]++;
      }
      const cell = gridItem('button', `cell${done ? ' is-done' : ''}`, row, c + 2);
      cell.type = 'button';
      cell.dataset.day = day;
      cell.dataset.id = habit.id;
      cell.disabled = day > currentDay;
      cell.setAttribute('aria-pressed', String(done));
      cell.setAttribute('aria-label', `${habit.name}, ${formatHeading(day)}`);
      nodes.push(cell);
    });

    total += doneCount;
    nodes.push(gridItem('div', 'week-grid__pct', row, 9, percent(doneCount, 7)));
  });

  perDay.forEach((count, c) => {
    nodes.push(gridItem('div', 'week-grid__pct week-grid__pct--day', HABITS.length + 1, c + 2,
      percent(count, HABITS.length)));
  });

  const outline = document.createElement('div');
  outline.className = 'today-outline';
  outline.style.gridColumn = String(todayCol + 2);
  nodes.push(outline);

  els.grid.replaceChildren(...nodes);

  // Overall weekly productivity: Sundays only
  const isSunday = fromKey(currentDay).getDay() === 0;
  els.weekTotal.hidden = !isSunday;
  els.weekTotal.textContent = isSunday ? `Week: ${percent(total, 7 * HABITS.length)}` : '';
}

function gridItem(tag, className, row, col, text) {
  const el = document.createElement(tag);
  el.className = className;
  el.style.gridRow = String(row);
  el.style.gridColumn = String(col);
  if (text !== undefined) el.textContent = text;
  return el;
}

function percent(n, of) {
  return `${Math.round((n / of) * 100)}%`;
}

function initGrid() {
  els.grid.addEventListener('click', (e) => {
    const cell = e.target.closest('.cell');
    if (!cell || cell.disabled) return;
    const { day, id } = cell.dataset;
    Store.setDone(day, id, !Store.isDone(day, id));
    renderWeek();
    // Today's (and, via note carry-over, any) change can affect the list
    renderToday({ animate: true });
  });
}

/* ---------- Day change ---------- */

let midnightTimer = null;

function renderAll() {
  currentDay = todayKey();
  renderToday();
  renderWeek();
}

function checkDay() {
  if (todayKey() !== currentDay) renderAll();
  scheduleMidnight();
}

function scheduleMidnight() {
  clearTimeout(midnightTimer);
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 1);
  midnightTimer = setTimeout(checkDay, next - now);
}

function initDayWatch() {
  scheduleMidnight();
  // Timers are unreliable while iOS has the app suspended, so re-check often
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkDay();
  });
  window.addEventListener('pageshow', checkDay);
  window.addEventListener('focus', checkDay);
  setInterval(checkDay, 60 * 1000);
}

/* ---------- Service worker ---------- */

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline support unavailable */ });
  });
}

/* ---------- Boot ---------- */

Store.load();
initWelcome();
initGrid();
renderAll();
initDayWatch();
registerServiceWorker();
