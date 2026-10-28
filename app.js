'use strict';

/* ==========================================================================
   Jade! — app logic
   Data lives in localStorage under STORAGE_KEY:
     {
       version: 3,
       habits: [{ id, name, position, archived }],
       days: { "YYYY-MM-DD": { done: { id: true }, notes: { id: "text" } } },
       todos: { today: [item], longterm: [item], goals: [item] },
       ui: { openGoals: [id] },   // this device only, not synced
       sync: { pending: { key: { table, row } }, cursor, user }
     }
   item = { id, text, created: "YYYY-MM-DD", doneOn: "YYYY-MM-DD" | null,
            doneAt: ISO time | null, position, parentId,
            type: "task" | "text", weight: "thin" | "regular" }.
   In the goals list, items without a parentId are goals; the others are
   that goal's blocks (text lines and tasks).
   Every change also goes through Sync.queue (sync.js) to Supabase; this
   local copy is what the app renders, so it opens instantly and offline.
   Older versions are upgraded on load by adding fields; nothing is lost.
   ========================================================================== */

// The habit list before the first sync; Store.data.habits after that.
// Ids are what get stored.
const DEFAULT_HABITS = [
  { id: 'sport', name: 'Sport' },
  { id: 'language', name: 'Language' },
  { id: 'blog', name: 'Blog/Clients' },
  { id: 'design', name: 'Design/Code' },
  { id: 'smartass', name: 'Smartass' },
];

let HABITS = []; // active habits in display order, see refreshHabits()

const STORAGE_KEY = 'habits.v1'; // name kept so existing data stays put
const TODO_LISTS = ['today', 'longterm', 'goals'];
const TASK_LISTS = ['today', 'longterm']; // plain lists; goals are their own thing
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

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

// Statistics: radar spokes run clockwise from the top in this order, filters
// left to right. Habits missing from a list are appended, so new ones show up.
const RADAR_ORDER = ['design', 'language', 'blog', 'smartass', 'sport'];
const FILTER_ORDER = ['sport', 'language', 'blog', 'smartass', 'design'];
const RADAR = { width: 390, height: 320, r: 130, labelGap: 8 }; // SVG units
const TIP_GAP = 6;

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
    this.data = { version: 2, days: {} };
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (parsed && parsed.days && typeof parsed.days === 'object') this.data = parsed;
    } catch (e) { /* fall through to empty data */ }
    this.migrate();
  },

  // v1 -> v2: add the to-do lists. v2 -> v3: add the habit list, item
  // positions and the sync state. Existing data is never touched.
  migrate() {
    const d = this.data;
    if (!d.todos || typeof d.todos !== 'object') d.todos = {};
    for (const name of TODO_LISTS) {
      if (!Array.isArray(d.todos[name])) d.todos[name] = [];
      d.todos[name].forEach((item, i) => {
        if (typeof item.position !== 'number') item.position = i;
        if (item.parentId === undefined) item.parentId = null;
        if (item.doneAt === undefined) item.doneAt = null;
        if (!item.type) item.type = 'task';
        if (!item.weight) item.weight = 'thin';
      });
    }
    if (!d.ui || typeof d.ui !== 'object') d.ui = {};
    if (!Array.isArray(d.ui.openGoals)) d.ui.openGoals = [];
    if (!Array.isArray(d.habits)) {
      d.habits = DEFAULT_HABITS.map((h, i) => ({ ...h, position: i, archived: false }));
    }
    if (!d.sync || typeof d.sync !== 'object') d.sync = {};
    if (!d.sync.pending || typeof d.sync.pending !== 'object') d.sync.pending = {};
    if (d.sync.cursor === undefined) d.sync.cursor = null;
    if (d.sync.user === undefined) d.sync.user = null;
    d.version = Math.max(d.version || 1, 3);
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
    Sync.queue('habit_checks', Rows.check(key, id, done));
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
    Sync.queue('habit_notes', Rows.note(key, id, id in day.notes ? day.notes[id] : null));
    this.prune(key);
    this.save();
  },

  /* ----- To-do lists ----- */

  todos(list) {
    return this.data.todos[list];
  },

  todo(list, id) {
    return this.todos(list).find((t) => t.id === id);
  },

  // fields: parentId (a goal's id, for its blocks), type, weight
  addTodo(list, text, fields = {}) {
    const parentId = fields.parentId || null;
    const siblings = this.todos(list).filter((t) => t.parentId === parentId);
    const item = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      text,
      created: currentDay,
      doneOn: null,
      doneAt: null,
      position: Math.max(-1, ...siblings.map((t) => t.position)) + 1,
      parentId,
      type: fields.type || 'task',
      weight: fields.weight || 'thin',
    };
    this.todos(list).push(item);
    Sync.queue('todos', Rows.todo(list, item));
    this.save();
    return item;
  },

  setTodoDone(list, id, done) {
    const item = this.todo(list, id);
    if (!item) return;
    item.doneOn = done ? currentDay : null;
    item.doneAt = done ? new Date().toISOString() : null;
    Sync.queue('todos', Rows.todo(list, item));
    this.save();
  },

  // fields: any of text, type, weight, doneOn, doneAt
  updateTodo(list, id, fields) {
    const item = this.todo(list, id);
    if (!item) return;
    Object.assign(item, fields);
    Sync.queue('todos', Rows.todo(list, item));
    this.save();
  },

  // Removing a goal removes its blocks too
  removeTodo(list, id) {
    const gone = this.todos(list).filter((t) => t.id === id || t.parentId === id);
    for (const item of gone) Sync.queue('todos', Rows.todo(list, item, true));
    this.data.todos[list] = this.todos(list).filter((t) => !gone.includes(t));
    this.save();
  },

  // Gives `id` a position between its neighbours in `ids` (the new order of
  // the items it was dragged among), so only one row changes. Equal
  // positions (old data) leave no room in between: then renumber them all.
  reposition(list, id, ids) {
    const items = ids.map((x) => this.todo(list, x));
    const i = ids.indexOf(id);
    if (i < 0 || items.some((t) => !t)) return;
    const prev = items[i - 1];
    const next = items[i + 1];
    let pos;
    if (prev && next) pos = (prev.position + next.position) / 2;
    else if (prev) pos = prev.position + 1;
    else if (next) pos = next.position - 1;
    else return;
    if ((prev && pos <= prev.position) || (next && pos >= next.position)) {
      items.forEach((t, k) => {
        if (t.position === k) return;
        t.position = k;
        Sync.queue('todos', Rows.todo(list, t));
      });
    } else {
      items[i].position = pos;
      Sync.queue('todos', Rows.todo(list, items[i]));
    }
    this.save();
  },

  /* ----- Goals ----- */

  goals() {
    return this.todos('goals').filter((t) => !t.parentId);
  },

  blocks(goalId) {
    return this.todos('goals').filter((t) => t.parentId === goalId).sort(byPosition);
  },

  isGoalOpen(id) {
    return this.data.ui.openGoals.includes(id);
  },

  setGoalOpen(id, open) {
    const ids = this.data.ui.openGoals.filter((x) => x !== id);
    if (open) ids.push(id);
    this.data.ui.openGoals = ids;
    this.save();
  },

  // A goal is done when it has at least one task and all of them are
  // checked. Stored on the goal (done_on/done_at) so other clients see it.
  // Returns whether it changed; a goal that just got done is closed.
  updateGoalDone(id) {
    const goal = this.todo('goals', id);
    if (!goal || goal.parentId) return false;
    const tasks = this.blocks(id).filter((b) => b.type === 'task');
    if (!tasks.length && isLegacyDone(goal)) return false; // see isExpired
    const done = tasks.length > 0 && tasks.every((t) => t.doneOn);
    if (done === !!goal.doneOn) return false;
    goal.doneOn = done ? currentDay : null;
    goal.doneAt = done ? new Date().toISOString() : null;
    if (done) this.setGoalOpen(id, false);
    Sync.queue('todos', Rows.todo('goals', goal));
    this.save();
    return true;
  },

  // After pulled changes: tasks may have changed on another device
  updateGoals() {
    for (const goal of this.goals()) this.updateGoalDone(goal.id);
    const ids = new Set(this.goals().map((g) => g.id));
    this.data.ui.openGoals = this.data.ui.openGoals.filter((id) => ids.has(id));
  },

  // Today and Long term: checked items stay for the rest of their day and
  // are gone from the next day on; unchecked ones carry over. Goals and
  // their blocks stay. Local only: the server keeps them as history.
  purgeTodos(key) {
    let changed = false;
    for (const name of TODO_LISTS) {
      const kept = this.todos(name).filter((t) => !isExpired(name, t, key));
      if (kept.length !== this.todos(name).length) {
        this.data.todos[name] = kept;
        changed = true;
      }
    }
    if (changed) this.save();
  },
};

const byPosition = (a, b) => a.position - b.position;
// Most recently checked first (items checked before done_at existed last)
const byLatestDone = (a, b) => (b.doneAt || '').localeCompare(a.doneAt || '') || byPosition(a, b);

// Before goals had tasks, a goal was checked like a to-do (no done_at) and
// disappeared the next day. Those keep doing that.
function isLegacyDone(item) {
  return !item.parentId && !!item.doneOn && !item.doneAt;
}

// Gone from the app from the day after it was checked
function isExpired(list, item, today) {
  if (!item.doneOn || item.doneOn >= today) return false;
  return list !== 'goals' || isLegacyDone(item);
}

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
  monthPrev: $('#stats-prev'),
  monthNext: $('#stats-next'),
  monthName: $('#stats-month-name'),
  monthTotal: $('#stats-month-total'),
  radar: $('#radar'),
  radarTip: $('#radar .chart-tip'),
  filters: $('#bar-filters'),
  bars: $('#bars'),
  barsScroll: $('#bars .bars__scroll'),
  barTip: $('#bars .chart-tip'),
  login: $('#login'),
  loginForm: $('#login form'),
  loginError: $('#login .login__error'),
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

// targets: everything that can shift, top to bottom (default: the Today list)
function flip(mutate, targets = flipTargets) {
  const before = new Map();
  for (const el of targets()) {
    before.set(el, el.getBoundingClientRect().top); // visual position, mid-slide included
    if (el._flip) el._flip.cancel();
  }

  mutate();

  let moved = 0;
  for (const el of targets()) {
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
function attachCardGestures(li, habit) {
  attachPressGestures(li, {
    inputSelector: '.habit__input',
    onLongPress: () => openNoteEditor(li, habit),
    onClick: (e) => {
      if (e.target.closest('.check')) toggleCard(li, habit);
    },
  });
}

// Shared by habit cards, to-do items and goals. A fired long press swallows
// the following click, so the two never overlap. The editor it opens is
// found with inputSelector and focused when the press ends.
// drag (optional): returns a Drag config, or false when the item can't move
// right now. With one, the long press waits: moving drags, releasing in
// place opens the editor.
function attachPressGestures(el, { inputSelector, onLongPress, onClick, drag }) {
  let pressTimer = null;
  let longPressed = false;
  let held = null; // the Drag config while held, before moving
  let startX = 0;
  let startY = 0;

  const cancelPress = () => {
    clearTimeout(pressTimer);
    pressTimer = null;
    el.classList.remove('is-pressing');
  };
  const setHeld = (cfg) => {
    held = cfg;
    el.classList.toggle('is-held', !!cfg); // pulled changes wait for it (onRemoteChange)
  };

  el.addEventListener('pointerdown', (e) => {
    if (e.target.closest(inputSelector)) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    longPressed = false;
    setHeld(null);
    startX = e.clientX;
    startY = e.clientY;
    cancelPress();
    el.classList.add('is-pressing');
    const { pointerId } = e;
    pressTimer = setTimeout(() => {
      pressTimer = null;
      longPressed = true;
      el.classList.remove('is-pressing');
      setHeld(drag ? drag() : null);
      if (!held) {
        onLongPress();
        return;
      }
      // Keep getting this pointer's events when it leaves the item
      try { el.setPointerCapture(pointerId); } catch (err) { /* already up */ }
    }, LONG_PRESS_MS);
  });

  const moveTo = (e, x, y) => {
    const moved = Math.hypot(x - startX, y - startY) > LONG_PRESS_MOVE_PX;
    if (pressTimer && moved) cancelPress();
    if (held && moved) {
      const cfg = held;
      setHeld(null);
      Drag.start(cfg, e, startY);
    }
  };
  el.addEventListener('pointermove', (e) => moveTo(e, e.clientX, e.clientY));

  // While held, a finger move must drag rather than scroll. preventDefault
  // here is what stops iOS from scrolling (and cancelling the pointer).
  el.addEventListener('touchmove', (e) => {
    if (!held && !Drag.active) return;
    e.preventDefault();
    const t = e.touches[0];
    if (held && t) moveTo(e, t.clientX, t.clientY);
  }, { passive: false });

  el.addEventListener('pointerup', () => {
    cancelPress();
    if (held) {
      setHeld(null);
      onLongPress();
    }
    if (longPressed) focusEditor(el, inputSelector);
  });
  el.addEventListener('pointercancel', () => {
    cancelPress();
    setHeld(null);
  });
  el.addEventListener('pointerleave', () => {
    if (!held) cancelPress();
  });

  // iOS only shows the keyboard when focus() runs inside a user gesture,
  // so focus the editor on the touchend that finishes the long press.
  el.addEventListener('touchend', (e) => {
    if (!longPressed) return;
    e.preventDefault(); // also suppresses the synthetic click
    focusEditor(el, inputSelector);
  }, { passive: false });

  el.addEventListener('click', (e) => {
    if (longPressed) {
      longPressed = false;
      return;
    }
    if (!e.target.closest(inputSelector)) onClick(e);
  });

  el.addEventListener('contextmenu', (e) => e.preventDefault());
}

function toggleCard(li, habit) {
  if (li._leaving) return;

  // Tapping again within the delay undoes the check
  if (li.classList.contains('is-done')) {
    clearTimeout(li._leaveTimer);
    li.classList.remove('is-done');
    Store.setDone(currentDay, habit.id, false);
    renderWeek();
    renderStats();
    return;
  }

  Store.setDone(currentDay, habit.id, true);
  li.classList.add('is-done');
  li.querySelector('.check').setAttribute('aria-label', `Undo ${habit.name}`);
  renderWeek();
  renderStats();
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

function focusEditor(li, inputSelector) {
  const input = li.querySelector(inputSelector);
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
    renderStats();
    // Today's (and, via note carry-over, any) change can affect the list
    renderToday({ animate: true });
  });
}

/* ---------- Statistics ----------
   Radar: each habit's share of the chosen month (dashed = month before).
   Bars: one per week since tracking started, grouped by month.
   All math lives in stats.js; tracking starts on the earliest day with data.
   Tapping a point, label or bar shows a tip; tapping elsewhere hides it. */

let statsMonth = null; // "YYYY-MM" in the radar; null = the current month
let radarPick = null; // habit id with its tip showing
let barFilter = 'all'; // 'all' or a habit id
let barPick = null; // Monday of the week with its tip showing

const habitIds = () => HABITS.map((h) => h.id);
const pct = (fraction) => `${Math.round(fraction * 100)}%`;

function trackingStart() {
  const earliest = Store.earliestKey();
  return earliest && earliest < currentDay ? earliest : currentDay;
}

function orderedHabits(order) {
  const rank = (h) => (order.includes(h.id) ? order.indexOf(h.id) : order.length);
  return [...HABITS].sort((a, b) => rank(a) - rank(b));
}

// "October", or "October 2025" outside the current year; short: "Oct"
function monthLabel(month, short = false) {
  const [y, m] = month.split('-').map(Number);
  const name = short ? MONTH_NAMES[m - 1].slice(0, 3) : MONTH_NAMES[m - 1];
  return y === fromKey(currentDay).getFullYear() ? name : `${name} ${y}`;
}

// "Oct 26"
function shortDate(key) {
  const d = fromKey(key);
  return `${MONTH_NAMES[d.getMonth()].slice(0, 3)} ${d.getDate()}`;
}

function escapeXML(text) {
  return text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
}

function renderStats() {
  renderMonth();
  renderBars();
}

function renderMonth() {
  const start = trackingStart();
  const first = Stats.monthOf(start);
  const last = Stats.monthOf(currentDay);
  if (!statsMonth || statsMonth > last) statsMonth = last;
  if (statsMonth < first) statsMonth = first;

  const ids = habitIds();
  const current = Stats.monthStats(Store.data.days, ids, statsMonth, start);
  const previous = Stats.monthStats(Store.data.days, ids, Stats.addMonths(statsMonth, -1), start);

  els.monthName.textContent = monthLabel(statsMonth);
  els.monthTotal.textContent = `· ${pct(current.total)}`;
  els.monthPrev.disabled = statsMonth <= first;
  els.monthNext.disabled = statsMonth >= last;
  renderRadar(current, previous);
}

function renderRadar(current, previous) {
  const habits = orderedHabits(RADAR_ORDER);
  const { width, height, r, labelGap } = RADAR;
  const cx = width / 2;
  const cy = height / 2;
  const angle = (i) => (2 * Math.PI * i) / habits.length; // clockwise from 12 o'clock
  const at = (i, dist) => [cx + dist * Math.sin(angle(i)), cy - dist * Math.cos(angle(i))];
  const xy = ([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`;
  const shape = (stats) => habits.map((h, i) => xy(at(i, r * stats.byHabit[h.id]))).join(' ');

  let svg = `<circle class="radar__ring" cx="${cx}" cy="${cy}" r="${r}"/>`;
  habits.forEach((h, i) => {
    const [x, y] = at(i, r);
    svg += `<line class="radar__spoke" x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}"/>`;
  });
  if (previous) svg += `<polygon class="radar__shape radar__shape--prev" points="${shape(previous)}"/>`;
  svg += `<polygon class="radar__shape" points="${shape(current)}"/>`;

  const points = {};
  habits.forEach((h, i) => {
    const point = at(i, r * current.byHabit[h.id]);
    points[h.id] = point;
    // Labels sit just outside the ring, pushed away from it on every side
    const [lx, ly] = at(i, r + labelGap);
    const sin = Math.sin(angle(i));
    const cos = Math.cos(angle(i));
    const anchor = Math.abs(sin) < 0.2 ? 'middle' : sin > 0 ? 'start' : 'end';
    const dy = cos > 0.5 ? '0' : cos < -0.5 ? '0.8em' : '0.35em';
    const name = escapeXML(h.name);
    svg += `
      <g class="radar__hit${h.id === radarPick ? ' is-picked' : ''}" data-id="${h.id}" role="button"
        aria-label="${name}: ${pct(current.byHabit[h.id])}">
        <circle cx="${point[0].toFixed(1)}" cy="${point[1].toFixed(1)}" r="16"/>
        <text class="radar__label" x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" dy="${dy}"
          text-anchor="${anchor}">${name}</text>
      </g>`;
  });
  if (points[radarPick]) {
    const [x, y] = points[radarPick];
    svg += `<circle class="radar__dot" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.5"/>`;
  }

  els.radarSvg.innerHTML = svg;
  els.radarSvg._points = points;
  els.radarSvg._values = current.byHabit;
  placeRadarTip();
}

function renderBars() {
  const habits = orderedHabits(FILTER_ORDER);
  if (!habits.some((h) => h.id === barFilter)) barFilter = 'all';
  els.filters.replaceChildren(...[{ id: 'all', name: 'All' }, ...habits].map((h) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `bar-filter${h.id === barFilter ? ' is-active' : ''}`;
    btn.dataset.id = h.id;
    btn.textContent = h.name;
    btn.setAttribute('aria-pressed', String(h.id === barFilter));
    return btn;
  }));

  // Weeks grouped by the month that holds most of their days
  const ids = habitIds();
  const mondays = Stats.weekStarts(trackingStart(), currentDay);
  const thisWeek = mondays[mondays.length - 1];
  const groups = [];
  for (const monday of mondays) {
    const month = Stats.weekMonth(monday);
    if (!groups.length || groups[groups.length - 1].month !== month) groups.push({ month, weeks: [] });
    const stats = Stats.weekStats(Store.data.days, ids, monday);
    groups[groups.length - 1].weeks.push({ monday, value: barFilter === 'all' ? stats.total : stats.byHabit[barFilter] });
  }

  const track = document.createElement('div');
  track.className = 'bars__track';
  for (const group of groups) {
    const groupEl = document.createElement('div');
    groupEl.className = 'bars__group';
    const cols = document.createElement('div');
    cols.className = 'bars__cols';
    for (const { monday, value } of group.weeks) {
      const bar = document.createElement('button');
      bar.type = 'button';
      bar.className = `bar${monday === thisWeek ? ' is-current' : ''}`;
      bar.dataset.monday = monday;
      bar.dataset.label = `${shortDate(monday)} – ${shortDate(Stats.addDays(monday, 6))} · ${pct(value)}`;
      bar.setAttribute('aria-label', bar.dataset.label);
      const fill = document.createElement('span');
      fill.className = 'bar__fill';
      fill.style.height = `${value * 100}%`;
      bar.appendChild(fill);
      cols.appendChild(bar);
    }
    const label = document.createElement('div');
    label.className = 'bars__month';
    label.textContent = monthLabel(group.month, true);
    groupEl.append(cols, label);
    track.appendChild(groupEl);
  }

  // Opens on the newest week and follows it, unless scrolled back in time
  const scroll = els.barsScroll;
  const atEnd = !scroll.hasChildNodes() || scroll.scrollLeft + scroll.clientWidth >= scroll.scrollWidth - 2;
  scroll.replaceChildren(track);
  if (atEnd) scroll.scrollLeft = scroll.scrollWidth;
  placeBarTip();
}

// x, y: the anchor relative to wrap. The tip sits above it, inside wrap.
function showTip(tip, wrap, x, y, text) {
  tip.textContent = text;
  tip.hidden = false;
  const left = Math.min(Math.max(x - tip.offsetWidth / 2, 0), wrap.clientWidth - tip.offsetWidth);
  tip.style.left = `${left}px`;
  tip.style.top = `${y - tip.offsetHeight - TIP_GAP}px`;
}

function placeRadarTip() {
  const svg = els.radarSvg;
  const point = radarPick && svg._points[radarPick];
  if (!point) {
    els.radarTip.hidden = true;
    return;
  }
  const box = svg.getBoundingClientRect();
  const wrap = els.radar.getBoundingClientRect();
  const scale = box.width / RADAR.width;
  const habit = HABITS.find((h) => h.id === radarPick);
  showTip(els.radarTip, els.radar,
    box.left - wrap.left + point[0] * scale,
    box.top - wrap.top + point[1] * scale,
    `${habit.name} · ${pct(svg._values[radarPick])}`);
}

function placeBarTip() {
  const bar = barPick && els.barsScroll.querySelector(`.bar[data-monday="${barPick}"]`);
  const view = els.barsScroll.getBoundingClientRect();
  const box = bar && bar.querySelector('.bar__fill').getBoundingClientRect();
  const x = box && box.left + box.width / 2;
  if (!bar || x < view.left || x > view.right) {
    els.barTip.hidden = true;
    return;
  }
  const wrap = els.bars.getBoundingClientRect();
  showTip(els.barTip, els.bars, x - wrap.left, box.top - wrap.top, bar.dataset.label);
}

function initStats() {
  els.radarSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  els.radarSvg.setAttribute('viewBox', `0 0 ${RADAR.width} ${RADAR.height}`);
  els.radar.prepend(els.radarSvg);

  const changeMonth = (n) => {
    statsMonth = Stats.addMonths(statsMonth, n);
    radarPick = null;
    renderMonth();
  };
  els.monthPrev.addEventListener('click', () => changeMonth(-1));
  els.monthNext.addEventListener('click', () => changeMonth(1));

  els.radarSvg.addEventListener('click', (e) => {
    const hit = e.target.closest('.radar__hit');
    if (!hit) return;
    radarPick = radarPick === hit.dataset.id ? null : hit.dataset.id;
    renderMonth();
  });

  els.filters.addEventListener('click', (e) => {
    const btn = e.target.closest('.bar-filter');
    if (!btn) return;
    barFilter = btn.dataset.id;
    renderBars();
  });

  els.barsScroll.addEventListener('click', (e) => {
    const bar = e.target.closest('.bar');
    if (!bar) return;
    barPick = barPick === bar.dataset.monday ? null : bar.dataset.monday;
    placeBarTip();
  });
  els.barsScroll.addEventListener('scroll', placeBarTip, { passive: true });

  document.addEventListener('click', (e) => {
    if (e.target.closest('.radar__hit, .bar, .bar-filter')) return;
    if (radarPick) {
      radarPick = null;
      renderMonth();
    }
    barPick = null;
    els.barTip.hidden = true;
  });

  window.addEventListener('resize', () => {
    placeRadarTip();
    placeBarTip();
  });
}

/* ---------- To Do List ----------
   Today and Long term: tap the circle to check/uncheck. Checked items move
   to the top of their section, latest first, and are gone the next day.
   Long press to edit (empty text deletes), or long press and move to drag.
   "+ add …" opens an inline input that stays open for the next item.
   Goals have their own section below. */

function todoSection(list) {
  return document.querySelector(`.todo-section[data-list="${list}"]`);
}

function todoUl(list) {
  return todoSection(list).querySelector('.todo-list');
}

// Checked items pinned at the top, then the rest in their own order
function orderedTodos(list) {
  const items = Store.todos(list);
  return [...items.filter((t) => t.doneOn).sort(byLatestDone), ...items.filter((t) => !t.doneOn).sort(byPosition)];
}

function renderTodos() {
  Store.purgeTodos(currentDay);
  Store.updateGoals();
  for (const list of TASK_LISTS) {
    todoUl(list).replaceChildren(...orderedTodos(list).map((item) => createTodo(list, item)));
  }
  renderGoals();
}

// Moves only the nodes that are out of place, so an input inside one of the
// others keeps its focus
function reorderChildren(parent, nodes) {
  nodes.forEach((node, i) => {
    if (parent.children[i] !== node) parent.insertBefore(node, parent.children[i] || null);
  });
}

// Checked items pinned at the top of ul: where dragging can't go
function pinnedCount(ul) {
  let n = 0;
  while (ul.children[n] && ul.children[n].classList.contains('is-done')) n++;
  return n;
}

function createTodo(list, item) {
  const li = document.createElement('li');
  li.className = `todo${item.doneOn ? ' is-done' : ''}`;
  li.dataset.id = item.id;
  li.innerHTML = `
    <button class="check check--sm" type="button">${CHECK_SVG}</button>
    <span class="todo__text"></span>`;
  li.querySelector('.todo__text').textContent = item.text;
  updateTodoLabel(li, item);
  attachPressGestures(li, {
    inputSelector: '.todo__input',
    onLongPress: () => openTodoEditor(li, list),
    onClick: (e) => {
      if (e.target.closest('.check')) toggleTodo(li, list);
    },
    drag: () => !li.classList.contains('is-done') && {
      el: li,
      min: pinnedCount(li.parentElement),
      onDrop: (ids) => Store.reposition(list, li.dataset.id, ids),
    },
  });
  return li;
}

function updateTodoLabel(li, item) {
  li.querySelector('.check').setAttribute('aria-label',
    `${item.doneOn ? 'Uncheck' : 'Check'} ${item.text}`);
}

// The item moves (to the top, or back among the unchecked) once the
// checkmark has been seen; quick taps on several items move them together.
function toggleTodo(li, list) {
  const item = Store.todo(list, li.dataset.id);
  if (!item) return;
  Store.setTodoDone(list, item.id, !item.doneOn);
  li.classList.toggle('is-done', !!item.doneOn);
  updateTodoLabel(li, item);
  const ul = todoUl(list);
  clearTimeout(ul._placeTimer);
  ul._placeTimer = setTimeout(() => placeTodos(list), COMPLETE_DELAY_MS);
}

function placeTodos(list) {
  if (Drag.active) return; // the drop puts everything in place
  const ul = todoUl(list);
  const byId = new Map([...ul.children].map((li) => [li.dataset.id, li]));
  const nodes = orderedTodos(list).map((t) => byId.get(t.id)).filter(Boolean);
  flip(() => reorderChildren(ul, nodes), () => [...ul.children]);
}

function openTodoEditor(li, list) {
  const item = Store.todo(list, li.dataset.id);
  if (!item) return;
  const textEl = li.querySelector('.todo__text');
  openInlineEditor(li, textEl, item.text, (text) => {
    if (!text) {
      Store.removeTodo(list, item.id);
      li.remove();
      return;
    }
    Store.updateTodo(list, item.id, { text });
    textEl.textContent = item.text;
    updateTodoLabel(li, item);
  });
}

// Swaps textEl for an input inside host until Enter, Escape or a tap
// outside. save(text) gets the trimmed text; empty means delete.
function openInlineEditor(host, textEl, value, save) {
  if (host.querySelector('.todo__input')) return;
  const input = createTodoInput(value);
  input.setAttribute('aria-label', 'Edit item');
  textEl.hidden = true;
  host.classList.add('is-editing');
  textEl.after(input);
  focusEnd(input); // works on desktop; on iOS the press's touchend focuses it

  let closed = false;
  const close = (keep) => {
    if (closed) return;
    closed = true;
    input.remove(); // may fire blur; `closed` makes that a no-op
    textEl.hidden = false;
    host.classList.remove('is-editing');
    if (keep) save(input.value.trim());
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      close(true);
    } else if (e.key === 'Escape') {
      close(false);
    }
  });
  input.addEventListener('blur', () => close(true));
}

function createTodoInput(value = '') {
  const input = document.createElement('input');
  input.className = 'todo__input';
  input.type = 'text';
  input.value = value;
  input.setAttribute('enterkeyhint', 'done');
  input.setAttribute('autocomplete', 'off');
  return input;
}

function renderAddButton(addEl) {
  const btn = document.createElement('button');
  btn.className = 'todo-add__btn';
  btn.type = 'button';
  btn.innerHTML = '<span class="todo-add__plus">+</span> ';
  btn.append(addEl.dataset.label);
  addEl.replaceChildren(btn);
}

// add(text) saves one item; returning false means nothing was added.
// circle: show a placeholder checkbox while typing.
function openAddInput(addEl, add, { circle = true } = {}) {
  const row = document.createElement('div');
  row.className = 'todo-add__row';
  if (circle) row.innerHTML = `<span class="check check--sm" aria-hidden="true"></span>`;
  const input = createTodoInput();
  input.placeholder = addEl.dataset.label;
  input.setAttribute('enterkeyhint', 'enter');
  input.setAttribute('aria-label', addEl.dataset.label);
  row.appendChild(input);
  addEl.replaceChildren(row);
  input.focus(); // inside the tap, so iOS shows the keyboard

  const save = () => {
    const text = input.value.trim();
    if (!text || add(text) === false) return false;
    input.value = '';
    return true;
  };

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    renderAddButton(addEl);
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      // Saved: stay open for the next one. Empty: done adding.
      if (!save()) close();
    } else if (e.key === 'Escape') {
      close();
    }
  });
  // Tapping outside keeps what was typed, then closes
  input.addEventListener('blur', () => {
    save();
    close();
  });
}

function initTodos() {
  for (const list of TASK_LISTS) {
    const addEl = todoSection(list).querySelector('.todo-add');
    renderAddButton(addEl);
    addEl.addEventListener('click', (e) => {
      if (!e.target.closest('.todo-add__btn')) return;
      openAddInput(addEl, (text) => {
        todoUl(list).appendChild(createTodo(list, Store.addTodo(list, text)));
      });
    });
  }

  const addGoal = todoSection('goals').querySelector('.todo-add');
  renderAddButton(addGoal);
  addGoal.addEventListener('click', (e) => {
    if (!e.target.closest('.todo-add__btn')) return;
    openAddInput(addGoal, (text) => {
      goalsUl().appendChild(createGoal(Store.addTodo('goals', text)));
    }, { circle: false });
  });
}

/* ---------- Goals ----------
   Each goal is a headline that opens and closes (tap; which ones are open
   is remembered on this device). Inside are its blocks, set by what the
   line starts with when typed (the prefix itself isn't shown):
     "[] Book the exam" -> a task with a checkbox
     "# Phase 1"        -> a text line in the regular weight (sub-heading)
     anything else      -> a text line in the thin weight
   Long press shows the prefix again for editing. A goal with at least one
   task, all checked, is done: it moves to the top, struck through and
   closed, and goes back to its place when a task is unchecked. */

const CHEVRON_SVG =
  '<svg viewBox="0 0 8 8" aria-hidden="true"><path d="M2.75 1 5.75 4 2.75 7" fill="none" ' +
  'stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function goalsUl() {
  return todoUl('goals');
}

function orderedGoals() {
  const goals = Store.goals();
  return [...goals.filter((g) => g.doneOn).sort(byLatestDone), ...goals.filter((g) => !g.doneOn).sort(byPosition)];
}

function renderGoals() {
  goalsUl().replaceChildren(...orderedGoals().map(createGoal));
}

function parseBlock(raw) {
  const text = raw.trim();
  if (/^\[\s?\]/.test(text)) return { type: 'task', weight: 'thin', text: text.replace(/^\[\s?\]\s*/, '') };
  if (text.startsWith('#')) return { type: 'text', weight: 'regular', text: text.replace(/^#+\s*/, '') };
  return { type: 'text', weight: 'thin', text };
}

function blockSource(item) {
  if (item.type === 'task') return `[] ${item.text}`;
  return item.weight === 'regular' ? `# ${item.text}` : item.text;
}

function createGoal(goal) {
  const li = document.createElement('li');
  li.className = 'goal';
  li.dataset.id = goal.id;
  li.innerHTML = `
    <div class="goal__head" role="button">
      <span class="goal__chevron">${CHEVRON_SVG}</span>
      <span class="goal__title todo__text"></span>
    </div>
    <div class="goal__body">
      <ul class="goal__blocks"></ul>
      <div class="todo-add goal__add" data-label="add a note"></div>
    </div>`;
  updateGoal(li);
  li.querySelector('.goal__blocks').replaceChildren(...Store.blocks(goal.id).map((b) => createBlock(li, b)));

  const addEl = li.querySelector('.goal__add');
  renderAddButton(addEl);
  addEl.addEventListener('click', (e) => {
    if (!e.target.closest('.todo-add__btn')) return;
    const blocks = li.querySelectorAll('.goal__blocks > .block[data-id]');
    openLine(li, blocks[blocks.length - 1] || null);
  });

  const head = li.querySelector('.goal__head');
  attachPressGestures(head, {
    inputSelector: '.todo__input',
    onLongPress: () => openGoalEditor(li),
    onClick: () => {
      Store.setGoalOpen(goal.id, !Store.isGoalOpen(goal.id));
      updateGoal(li);
    },
    drag: () => !li.classList.contains('is-done') && {
      el: li,
      min: pinnedCount(li.parentElement),
      onDrop: (ids) => Store.reposition('goals', goal.id, ids),
    },
  });
  return li;
}

function updateGoal(li) {
  const goal = Store.todo('goals', li.dataset.id);
  if (!goal) return;
  const open = Store.isGoalOpen(goal.id);
  li.classList.toggle('is-done', !!goal.doneOn);
  li.classList.toggle('is-open', open);
  li.querySelector('.goal__title').textContent = goal.text;
  const head = li.querySelector('.goal__head');
  head.setAttribute('aria-expanded', String(open));
  head.setAttribute('aria-label', `${goal.text}${goal.doneOn ? ', done' : ''}`);
}

// After its blocks changed: a goal that got done (or undone) moves, once
// the checkmark has been seen
function refreshGoal(li, delay = 0) {
  if (Store.updateGoalDone(li.dataset.id)) placeGoal(li, delay);
}

function placeGoal(li, delay) {
  clearTimeout(li._placeTimer);
  li._placeTimer = setTimeout(() => {
    if (!li.isConnected) return;
    // Not mid-drag or while writing in it: moving it would close the input
    if (Drag.active || li.querySelector('.todo__input')) {
      placeGoal(li, 300);
      return;
    }
    const ul = goalsUl();
    const byId = new Map([...ul.children].map((g) => [g.dataset.id, g]));
    const nodes = orderedGoals().map((g) => byId.get(g.id)).filter(Boolean);
    flip(() => {
      updateGoal(li);
      reorderChildren(ul, nodes);
    }, () => [...ul.children, todoSection('goals').querySelector(':scope > .todo-add')]);
  }, delay);
}

function openGoalEditor(li) {
  const goal = Store.todo('goals', li.dataset.id);
  if (!goal) return;
  const textEl = li.querySelector('.goal__title');
  openInlineEditor(li.querySelector('.goal__head'), textEl, goal.text, (text) => {
    if (!text) {
      Store.setGoalOpen(goal.id, false);
      Store.removeTodo('goals', goal.id);
      li.remove();
      return;
    }
    Store.updateTodo('goals', goal.id, { text });
    updateGoal(li);
  });
}

function createBlock(goalLi, item) {
  const li = document.createElement('li');
  const task = item.type === 'task';
  li.className = `block block--${item.type}${item.weight === 'regular' ? ' block--regular' : ''}` +
    `${task && item.doneOn ? ' is-done' : ''}`;
  li.dataset.id = item.id;
  li.innerHTML = task
    ? `<button class="check check--xs" type="button">${CHECK_SVG}</button><span class="todo__text"></span>`
    : '<span class="todo__text"></span>';
  li.querySelector('.todo__text').textContent = item.text;
  if (task) updateTodoLabel(li, item);
  attachPressGestures(li, {
    inputSelector: '.todo__input',
    onLongPress: () => openBlockEditor(goalLi, li),
    onClick: (e) => {
      if (task && e.target.closest('.check')) toggleBlock(goalLi, li);
    },
    drag: () => !li.classList.contains('is-done') && {
      el: li,
      onDrop: (ids) => Store.reposition('goals', item.id, ids),
    },
  });
  return li;
}

// The goal's blocks in screen order (lines being typed have no id yet)
function blockIds(goalLi) {
  return [...goalLi.querySelectorAll('.goal__blocks > .block[data-id]')].map((b) => b.dataset.id);
}

// Saves a parsed line as a new block just before `beforeEl` (the line input)
function insertBlock(goalLi, beforeEl, block) {
  const item = Store.addTodo('goals', block.text, {
    parentId: goalLi.dataset.id, type: block.type, weight: block.weight,
  });
  beforeEl.before(createBlock(goalLi, item));
  Store.reposition('goals', item.id, blockIds(goalLi));
  refreshGoal(goalLi);
}

function toggleBlock(goalLi, li) {
  const item = Store.todo('goals', li.dataset.id);
  if (!item) return;
  Store.setTodoDone('goals', item.id, !item.doneOn);
  li.classList.toggle('is-done', !!item.doneOn);
  updateTodoLabel(li, item);
  refreshGoal(goalLi, COMPLETE_DELAY_MS);
}

/* ----- Writing lines (Notion-like) -----
   New lines and edited blocks share the same keys:
     Enter      saves the line and opens a new one below it; after a task
                the new line starts with "[] ", so lists continue
     Enter on a bare prefix ("[] ", "# ") drops the prefix; on an empty
                line it closes
     Backspace  on an empty line removes it and continues at the end of
                the line above
     Paste      several lines: one block per line, each with its prefix
   The next input is always focused before the old one is removed, so
   the iPhone keyboard stays up. */

const LINE_HINT = 'Text · # bold · [] task';

const continuation = (block) => (block.type === 'task' ? '[] ' : '');

function createLineInput(value) {
  const input = createTodoInput(value);
  input.placeholder = LINE_HINT;
  input.setAttribute('enterkeyhint', 'enter');
  input.setAttribute('aria-label', 'Note');
  return input;
}

function focusEnd(input) {
  input.focus();
  const end = input.value.length;
  input.setSelectionRange(end, end);
}

// keys: { enter, backspace (on an empty line), paste(lines), escape }
function attachLineKeys(input, keys) {
  input.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      keys.enter();
    } else if (e.key === 'Backspace' && input.value === '') {
      e.preventDefault();
      keys.backspace();
    } else if (e.key === 'Escape') {
      keys.escape();
    }
  });
  input.addEventListener('paste', (e) => {
    const text = e.clipboardData ? e.clipboardData.getData('text') : '';
    if (!/[\r\n]/.test(text)) return;
    e.preventDefault();
    const { selectionStart: from, selectionEnd: to, value } = input;
    keys.paste((value.slice(0, from) + text + value.slice(to)).split(/\r?\n/));
  });
}

function closeLineIn(goalLi, li) {
  li.remove();
  goalLi.classList.toggle('is-writing', !!goalLi.querySelector('.block--line'));
}

// A new line after prevEl (a block, or null for the top). Returns
// { paste(lines) } so an edited block can hand pasted lines over.
function openLine(goalLi, prevEl, value = '') {
  const existing = goalLi.querySelector('.block--line');
  if (existing && !prevEl) {
    focusEnd(existing.querySelector('input'));
    return null;
  }
  const li = document.createElement('li');
  li.className = 'block block--line';
  const input = createLineInput(value);
  li.appendChild(input);
  if (prevEl) prevEl.after(li);
  else goalLi.querySelector('.goal__blocks').prepend(li);
  goalLi.classList.add('is-writing');
  focusEnd(input); // inside the tap or key press, so iOS shows the keyboard

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    closeLineIn(goalLi, li);
  };
  const paste = (lines) => {
    let last = null;
    for (const line of lines) {
      const block = parseBlock(line);
      if (!block.text) continue;
      insertBlock(goalLi, li, block);
      last = block;
    }
    input.value = last ? continuation(last) : '';
    focusEnd(input);
  };

  attachLineKeys(input, {
    enter: () => {
      if (!input.value.trim()) {
        close();
        return;
      }
      const block = parseBlock(input.value);
      if (block.text) insertBlock(goalLi, li, block);
      input.value = block.text ? continuation(block) : ''; // bare prefix: dropped
      focusEnd(input);
    },
    backspace: () => {
      const prev = li.previousElementSibling;
      closed = true; // the blur below must not save
      if (prev && prev.dataset.id) openBlockEditor(goalLi, prev);
      closeLineIn(goalLi, li);
    },
    paste,
    escape: close,
  });
  // Tapping outside keeps what was typed
  input.addEventListener('blur', () => {
    if (closed) return;
    const block = parseBlock(input.value);
    if (block.text) insertBlock(goalLi, li, block);
    close();
  });
  return { paste };
}

// Editing shows the prefix, so the type can be changed by adding or
// removing it. A task that becomes text loses its checkmark. Clearing the
// line and saving deletes the block.
function openBlockEditor(goalLi, li) {
  if (li.querySelector('.todo__input')) return;
  const item = Store.todo('goals', li.dataset.id);
  if (!item) return;
  const textEl = li.querySelector('.todo__text');
  const input = createLineInput(blockSource(item));
  textEl.hidden = true;
  li.classList.add('is-editing');
  textEl.after(input);
  focusEnd(input); // works on desktop; on iOS the press's touchend focuses it

  let closed = false;
  const finish = (save) => {
    if (closed) return;
    closed = true;
    input.remove(); // may fire blur; `closed` makes that a no-op
    textEl.hidden = false;
    li.classList.remove('is-editing');
    if (!save) return;
    const block = parseBlock(input.value);
    if (!block.text) {
      Store.removeTodo('goals', item.id);
      li.remove();
    } else {
      const fields = { ...block };
      if (block.type !== 'task') Object.assign(fields, { doneOn: null, doneAt: null });
      Store.updateTodo('goals', item.id, fields);
      li.replaceWith(createBlock(goalLi, item));
    }
    refreshGoal(goalLi);
  };

  attachLineKeys(input, {
    enter: () => {
      if (!input.value.trim()) {
        finish(true); // deletes the block
        return;
      }
      const block = parseBlock(input.value);
      if (!block.text) {
        input.value = ''; // bare prefix: dropped
        return;
      }
      openLine(goalLi, li, continuation(block));
      finish(true);
    },
    backspace: () => {
      const prev = li.previousElementSibling;
      if (prev && prev.dataset.id) openBlockEditor(goalLi, prev);
      finish(true); // empty: deletes this block
    },
    // This block takes the first line, the rest become new blocks after it
    paste: ([first, ...rest]) => {
      input.value = first;
      const line = openLine(goalLi, li);
      finish(true);
      line.paste(rest);
    },
    escape: () => finish(false),
  });
  input.addEventListener('blur', () => finish(true));
}

/* ---------- Drag and drop ----------
   Long press, then move without lifting: the item lifts and follows the
   pointer while the items around it slide out of the way; releasing drops
   it there. The first `min` items (checked ones pinned at the top) can't be
   passed. Near the top or bottom edge the screen scrolls along. Positions
   are kept in screen-content coordinates so scrolling mid-drag is fine. */

const DRAG_SCALE = 1.03;
const DRAG_SHIFT_MS = 200; // others making room
const DRAG_SETTLE_MS = 250; // the drop
const AUTOSCROLL_EDGE_PX = 80;
const AUTOSCROLL_MAX_PX = 12; // per frame, right at the edge

// clientY of a pointer or touch event
const eventY = (e) => (e.touches ? (e.touches[0] || e.changedTouches[0]).clientY : e.clientY);

const Drag = {
  active: null,

  // cfg: { el, min, onDrop(ids) } with ids = the new order from index min on.
  // startY: where the press began, so the item stays under the finger.
  start(cfg, e, startY) {
    const { el } = cfg;
    if (!el.isConnected) return; // re-rendered meanwhile
    const siblings = [...el.parentElement.children];
    for (const s of siblings) s.getAnimations().forEach((a) => a.cancel());
    const scroller = el.closest('.screen');
    const scroll0 = scroller.scrollTop;
    const boxes = siblings.map((s) => {
      const r = s.getBoundingClientRect();
      return { top: r.top + scroll0, height: r.height };
    });
    const from = siblings.indexOf(el);
    this.active = {
      cfg, el, siblings, boxes, from, to: from, scroller, scroll0,
      min: Math.min(cfg.min || 0, from), startY, y: eventY(e), frame: 0,
    };

    el.classList.add('is-lifted');
    el.style.transition = 'none';
    for (const s of siblings) if (s !== el) s.style.transition = `transform ${DRAG_SHIFT_MS}ms ${EASE_OUT}`;
    document.body.classList.add('is-dragging');

    // Window listeners: the pointer leaves the item. Touch events too, in
    // case the browser stops sending pointer events mid-gesture.
    this.onMove = (ev) => {
      if (ev.type === 'touchmove') ev.preventDefault(); // no scrolling
      this.active.y = eventY(ev);
      this.update();
    };
    this.onEnd = (ev) => {
      if (ev.type === 'pointercancel' && ev.pointerType === 'touch') return; // touchend follows
      this.drop();
    };
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('touchmove', this.onMove, { passive: false });
    for (const type of ['pointerup', 'pointercancel', 'touchend', 'touchcancel']) {
      window.addEventListener(type, this.onEnd);
    }
    this.update();
    this.scrollLoop();
  },

  update() {
    const a = this.active;
    const dy = a.y - a.startY + a.scroller.scrollTop - a.scroll0;
    a.el.style.transform = `translateY(${dy}px) scale(${DRAG_SCALE})`;

    const box = a.boxes[a.from];
    const center = box.top + dy + box.height / 2;
    const mid = (i) => a.boxes[i].top + a.boxes[i].height / 2;
    let to = a.from;
    while (to > a.min && center < mid(to - 1)) to--;
    while (to < a.boxes.length - 1 && center > mid(to + 1)) to++;
    if (to === a.to) return;
    a.to = to;

    a.siblings.forEach((s, i) => {
      if (s === a.el) return;
      let shift = 0;
      if (i > a.from && i <= to) shift = -box.height;
      else if (i < a.from && i >= to) shift = box.height;
      s.style.transform = shift ? `translateY(${shift}px)` : '';
    });
  },

  // Faster the closer the pointer gets to the edge (the tab bar counts as edge)
  scrollLoop() {
    const a = this.active;
    if (!a) return;
    const r = a.scroller.getBoundingClientRect();
    const top = r.top + AUTOSCROLL_EDGE_PX;
    const bottom = r.bottom - document.querySelector('.tabbar').offsetHeight - AUTOSCROLL_EDGE_PX;
    const ratio = a.y < top ? (a.y - top) / AUTOSCROLL_EDGE_PX : a.y > bottom ? (a.y - bottom) / AUTOSCROLL_EDGE_PX : 0;
    if (ratio) {
      const before = a.scroller.scrollTop;
      a.scroller.scrollTop += Math.max(-1, Math.min(1, ratio)) * AUTOSCROLL_MAX_PX;
      if (a.scroller.scrollTop !== before) this.update();
    }
    a.frame = requestAnimationFrame(() => this.scrollLoop());
  },

  // Into the new order, then FLIP everything from where it's seen to its
  // real place: the dragged item settles, the others finish making room.
  drop() {
    const a = this.active;
    this.active = null;
    cancelAnimationFrame(a.frame);
    window.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('touchmove', this.onMove, { passive: false });
    for (const type of ['pointerup', 'pointercancel', 'touchend', 'touchcancel']) {
      window.removeEventListener(type, this.onEnd);
    }
    document.body.classList.remove('is-dragging');

    const order = a.siblings.filter((s) => s !== a.el);
    order.splice(a.to, 0, a.el);
    const center = (s) => {
      const r = s.getBoundingClientRect();
      return r.top + r.height / 2;
    };
    const before = new Map(a.siblings.map((s) => [s, center(s)]));
    for (const s of a.siblings) {
      s.style.transition = 'none';
      s.style.transform = '';
    }
    reorderChildren(a.el.parentElement, order);
    a.el.style.transition = `box-shadow ${DRAG_SETTLE_MS}ms ease, background-color ${DRAG_SETTLE_MS}ms ease`;
    a.el.classList.remove('is-lifted');

    for (const s of a.siblings) {
      const dy = before.get(s) - center(s);
      const scale = s === a.el ? ` scale(${DRAG_SCALE})` : '';
      if (Math.abs(dy) < 0.5 && !scale) continue;
      s.animate([{ transform: `translateY(${dy}px)${scale}` }, { transform: 'none' }],
        { duration: DRAG_SETTLE_MS, easing: EASE_OUT });
    }
    setTimeout(() => a.siblings.forEach((s) => { s.style.transition = ''; }), DRAG_SETTLE_MS);

    // Lines still being typed have no id yet and don't count
    if (a.to !== a.from) a.cfg.onDrop(order.slice(a.min).map((s) => s.dataset.id).filter(Boolean));
  },
};

/* ---------- Tabs ---------- */

function showScreen(name) {
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  for (const screen of document.querySelectorAll('.screen')) {
    screen.classList.toggle('is-active', screen.id === name);
  }
  for (const tab of document.querySelectorAll('.tab')) {
    const active = tab.dataset.screen === name;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-pressed', String(active));
  }
}

function initTabs() {
  document.querySelector('.tabbar').addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (tab) showScreen(tab.dataset.screen);
  });
}

/* ---------- Login & sync ----------
   One-time login (no sign-up: the account is made in Supabase). The
   session is kept, so the phone stays logged in; the login screen only
   comes back if Supabase rejects the session. */

function refreshHabits() {
  HABITS = Store.data.habits
    .filter((h) => !h.archived)
    .sort((a, b) => a.position - b.position);
}

function showLogin(show) {
  els.login.hidden = !show;
  if (show) els.loginError.textContent = '';
}

function initLogin() {
  els.loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = els.loginForm.email.value.trim();
    const password = els.loginForm.password.value;
    const button = els.loginForm.querySelector('button');
    button.disabled = true;
    els.loginError.textContent = '';
    try {
      await Auth.signIn(email, password);
      els.loginForm.password.value = '';
      document.activeElement.blur();
      showLogin(false);
      Sync.schedule(); // first login uploads the local data
    } catch (err) {
      els.loginError.textContent = navigator.onLine && err.status
        ? 'Wrong email or password'
        : 'No connection. Try again when online.';
    } finally {
      button.disabled = false;
    }
  });
}

// Pulled changes: re-render, but not under an open editor
function onRemoteChange() {
  const editing = document.activeElement && document.activeElement.matches('input');
  const pressing = Drag.active || document.querySelector('.is-held');
  if (editing || pressing || !els.login.hidden) {
    setTimeout(onRemoteChange, 1000);
    return;
  }
  refreshHabits();
  renderToday();
  renderWeek();
  renderStats();
  renderTodos();
}

/* ---------- Day change ---------- */

let midnightTimer = null;

function renderAll() {
  currentDay = todayKey();
  statsMonth = null; // back to the current month
  renderToday();
  renderWeek();
  renderStats();
  renderTodos();
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
refreshHabits();
Auth.load();
Sync.onChange = onRemoteChange;
Sync.onSignedOut = () => showLogin(true);
initWelcome();
initLogin();
showLogin(!Auth.session);
initGrid();
initStats();
initTodos();
initTabs();
renderAll();
initDayWatch();
Sync.init();
Sync.schedule();
registerServiceWorker();
