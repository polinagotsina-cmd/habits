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
const COMPLETE_DELAY_MS = 600;
const COLLAPSE_MS = 460; // matches .habit.is-collapsing transition in styles.css

const WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

const CHECK_SVG =
  '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6.2 5 8.6 9.5 3.6" ' +
  'fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

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

function renderToday() {
  els.heading.textContent = formatHeading(currentDay);
  els.list.replaceChildren(
    ...HABITS.filter((h) => !Store.isDone(currentDay, h.id)).map(createCard)
  );
  updateAllDone();
}

function updateAllDone() {
  els.allDone.hidden = els.list.children.length > 0;
}

function createCard(habit) {
  const li = document.createElement('li');
  li.className = 'habit';
  li.dataset.id = habit.id;
  li.innerHTML = `
    <button class="check" type="button" aria-label="Mark ${habit.name} done">${CHECK_SVG}</button>
    <div class="habit__body">
      <div class="habit__name"></div>
      <div class="habit__note"></div>
    </div>`;
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
  if (li.classList.contains('is-collapsing')) return;

  // Tapping again within the delay undoes the check
  if (li.classList.contains('is-done')) {
    clearTimeout(li._collapseTimer);
    li.classList.remove('is-done');
    Store.setDone(currentDay, habit.id, false);
    renderWeek();
    return;
  }

  Store.setDone(currentDay, habit.id, true);
  li.classList.add('is-done');
  li.querySelector('.check').setAttribute('aria-label', `Undo ${habit.name}`);
  renderWeek();
  li._collapseTimer = setTimeout(() => collapseCard(li), COMPLETE_DELAY_MS);
}

function collapseCard(li) {
  li.style.height = `${li.offsetHeight}px`;
  void li.offsetHeight; // commit the start height before transitioning
  li.classList.add('is-collapsing');
  li.style.height = '0px';
  setTimeout(() => {
    li.remove();
    updateAllDone();
  }, COLLAPSE_MS);
}

/* ---------- Note editor ---------- */

function openNoteEditor(li, habit) {
  if (li.querySelector('.habit__input')) return;
  const day = currentDay;
  const body = li.querySelector('.habit__body');
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
  body.appendChild(input);
  input.focus(); // works on desktop; on iOS see the touchend handler

  let cancelled = false;
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      input.blur();
    } else if (e.key === 'Escape') {
      cancelled = true;
      input.blur();
    }
  });
  input.addEventListener('blur', () => {
    if (!cancelled) Store.setNote(day, habit.id, input.value.trim());
    input.remove();
    renderNote(li, habit);
  }, { once: true });
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
    renderToday();
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
