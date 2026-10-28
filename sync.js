'use strict';

/* ==========================================================================
   Jade! — login and sync with Supabase (plain fetch, no library)
   localStorage stays the source the app renders from; this file mirrors it
   to the tables in supabase/*.sql (see docs/DATABASE.md).

   Push: every local change is put in an outbox (Store.data.sync.pending,
   keyed by table + row key, holding the row's latest state with the time
   it changed) and upserted shortly after. The server keeps whichever
   version of a row changed last (jade_touch trigger), so pushes can arrive
   late and in any order.
   Pull: on open, on return to the foreground and on reconnect, fetch the
   rows whose synced_at is newer than the last pull and apply them, unless
   the outbox holds a newer local change to the same row.
   First login: all local data is uploaded with "insert, never overwrite",
   then everything is pulled, so data from both sides ends up in both.
   ========================================================================== */

// The publishable (anon) key is meant to be public: Row Level Security
// is what protects the data. Never put the secret/service_role key here.
const SUPABASE_URL = 'https://cvysjhzjchzfjllnhhtr.supabase.co';
const SUPABASE_KEY = 'sb_publishable_mFp_-C0XSQPUbLdlDz2J_w_mX1cPrqu';

const SESSION_KEY = 'jade.session';
const PUSH_DELAY_MS = 800; // batch quick successive taps into one request
const PULL_EVERY_MS = 5 * 60 * 1000; // while the app stays open
const PULL_OVERLAP_MS = 60 * 1000; // re-read a little: commits can land out of order
const PAGE_SIZE = 1000; // PostgREST's default max rows per request
const REFRESH_EARLY_S = 60;
const RETRY_MIN_MS = 5 * 1000; // after a failed sync, doubling up to RETRY_MAX_MS
const RETRY_MAX_MS = 60 * 1000;

// Push order matters: checks and notes need their habit, sub-tasks their goal
const TABLES = {
  habits: { key: ['id'], order: 'id' },
  habit_checks: { key: ['date', 'habit_id'], order: 'date,habit_id' },
  habit_notes: { key: ['date', 'habit_id'], order: 'date,habit_id' },
  todos: { key: ['id'], order: 'id' },
};

class AuthError extends Error {}

/* ---------- Session ---------- */

const Auth = {
  session: null, // { access_token, refresh_token, expires_at (s), user: { id, email } }
  refreshing: null,

  load() {
    try {
      const s = JSON.parse(localStorage.getItem(SESSION_KEY));
      if (s && s.refresh_token && s.user) this.session = s;
    } catch (e) { /* signed out */ }
  },

  set(s) {
    this.session = s && {
      access_token: s.access_token,
      refresh_token: s.refresh_token,
      expires_at: s.expires_at || Math.floor(Date.now() / 1000) + s.expires_in,
      user: { id: s.user.id, email: s.user.email },
    };
    try {
      if (this.session) localStorage.setItem(SESSION_KEY, JSON.stringify(this.session));
      else localStorage.removeItem(SESSION_KEY);
    } catch (e) { /* storage unavailable */ }
  },

  get userId() {
    return this.session ? this.session.user.id : null;
  },

  async signIn(email, password) {
    this.set(await authRequest('password', { email, password }));
  },

  // A valid access token, refreshed when close to expiry. A rejected
  // refresh token means the session is over: AuthError.
  async token() {
    if (!this.session) throw new AuthError('Signed out');
    if (this.session.expires_at - Date.now() / 1000 > REFRESH_EARLY_S) return this.session.access_token;
    if (!this.refreshing) {
      this.refreshing = authRequest('refresh_token', { refresh_token: this.session.refresh_token })
        .then((s) => this.set(s))
        .catch((e) => {
          if (e.status >= 400 && e.status < 500) {
            this.set(null);
            throw new AuthError(e.message);
          }
          throw e; // offline or server trouble: keep the session, try later
        })
        .finally(() => { this.refreshing = null; });
    }
    await this.refreshing;
    return this.session.access_token;
  },
};

async function authRequest(grant, body) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=${grant}`, {
    method: 'POST',
    headers: { apikey: SUPABASE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json.error_description || json.msg || json.message || `Error ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

// A 401 can be a token the server thinks expired (device clock off):
// refresh once and retry before treating it as signed out.
async function rest(path, options = {}, retried = false) {
  const { method = 'GET', body, prefer } = options;
  const headers = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${await Auth.token()}`,
    'Content-Type': 'application/json',
  };
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers,
    body: body && JSON.stringify(body),
  });
  if (res.status === 401) {
    if (retried) throw new AuthError('Session rejected');
    Auth.session.expires_at = 0;
    return rest(path, options, true);
  }
  if (!res.ok) throw new Error(`${method} ${path.split('?')[0]}: ${res.status} ${await res.text()}`);
  return method === 'GET' ? res.json() : null;
}

/* ---------- Rows: local data <-> table rows ----------
   Every row of a table has the same columns, so batches upsert cleanly. */

const Rows = {
  habit: (h) => ({ id: h.id, name: h.name, position: h.position, archived: !!h.archived }),
  check: (date, habitId, done) => ({ date, habit_id: habitId, done }),
  note: (date, habitId, note) => ({ date, habit_id: habitId, note }), // null = no own note
  todo: (list, item, deleted = false) => ({
    id: item.id,
    list,
    parent_id: item.parentId || null,
    text: item.text,
    position: item.position,
    created_on: item.created,
    done_on: item.doneOn || null,
    done_at: item.doneAt || null,
    type: item.type,
    weight: item.weight,
    deleted,
  }),
};

const rowKey = (table, row) => `${table}:${TABLES[table].key.map((k) => row[k]).join('|')}`;
const newer = (a, b) => Date.parse(a) > Date.parse(b);

// Everything stored locally, as rows (for the first upload)
function allRows() {
  const out = { habits: [], habit_checks: [], habit_notes: [], todos: [] };
  const d = Store.data;
  for (const h of d.habits) out.habits.push(Rows.habit(h));
  for (const [date, day] of Object.entries(d.days)) {
    for (const id of Object.keys(day.done)) out.habit_checks.push(Rows.check(date, id, true));
    for (const [id, note] of Object.entries(day.notes)) out.habit_notes.push(Rows.note(date, id, note));
  }
  for (const list of TODO_LISTS) {
    // Goals before their blocks
    const items = [...d.todos[list]].sort((a, b) => !!a.parentId - !!b.parentId);
    for (const item of items) out.todos.push(Rows.todo(list, item));
  }
  // Checks/notes may name habits that aren't in the list (renamed or removed
  // ids): give them a habit row so nothing is rejected.
  const known = new Set(out.habits.map((h) => h.id));
  for (const row of [...out.habit_checks, ...out.habit_notes]) {
    if (!known.has(row.habit_id)) {
      known.add(row.habit_id);
      out.habits.push({ id: row.habit_id, name: row.habit_id, position: out.habits.length, archived: true });
    }
  }
  return out;
}

// Apply one pulled row to the local data
function applyRow(table, row) {
  const d = Store.data;
  if (table === 'habits') {
    const h = { id: row.id, name: row.name, position: row.position, archived: row.archived };
    const i = d.habits.findIndex((x) => x.id === row.id);
    if (i < 0) d.habits.push(h);
    else d.habits[i] = h;
  } else if (table === 'habit_checks') {
    const day = Store.day(row.date, true);
    if (row.done) day.done[row.habit_id] = true;
    else delete day.done[row.habit_id];
    Store.prune(row.date);
  } else if (table === 'habit_notes') {
    const day = Store.day(row.date, true);
    if (row.note === null) delete day.notes[row.habit_id];
    else day.notes[row.habit_id] = row.note;
    Store.prune(row.date);
  } else if (table === 'todos') {
    for (const list of TODO_LISTS) d.todos[list] = d.todos[list].filter((t) => t.id !== row.id);
    const item = {
      id: row.id,
      text: row.text,
      created: row.created_on,
      doneOn: row.done_on,
      doneAt: row.done_at || null,
      position: row.position,
      parentId: row.parent_id,
      type: row.type || 'task',
      weight: row.weight || 'thin',
    };
    // Deleted, or checked on an earlier day (gone from the app, kept on the server)
    if (row.deleted || isExpired(row.list, item, todayKey())) return;
    const items = d.todos[row.list];
    items.push(item);
    items.sort((a, b) => a.position - b.position);
  }
}

/* ---------- Sync ---------- */

const Sync = {
  timer: null,
  retryMs: 0,
  running: false,
  again: false,
  onChange: () => {}, // pulled data changed the local data
  onSignedOut: () => {},

  // Record a local change; the row is pushed shortly
  queue(table, row) {
    row.updated_at = new Date().toISOString();
    Store.data.sync.pending[rowKey(table, row)] = { table, row };
    this.schedule(PUSH_DELAY_MS);
  },

  schedule(delay = 0) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.run(), delay);
  },

  // Upload first, then download. One run at a time; a request made while
  // running runs again right after.
  async run() {
    if (!Auth.session || !navigator.onLine) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    try {
      if (Store.data.sync.user !== Auth.userId) await this.firstUpload();
      await this.push();
      await this.pull();
      this.retryMs = 0;
    } catch (e) {
      if (e instanceof AuthError) {
        this.onSignedOut();
      } else {
        // Offline or server trouble. navigator.onLine can claim "online"
        // without a working connection (and then never fire "online"), so
        // retry on a timer instead of waiting for the event.
        console.warn('[sync]', e.message);
        this.retryMs = Math.min(Math.max(this.retryMs * 2, RETRY_MIN_MS), RETRY_MAX_MS);
        if (!this.again) this.schedule(this.retryMs);
      }
    } finally {
      this.running = false;
      if (this.again) {
        this.again = false;
        this.schedule();
      }
    }
  },

  // Every local row, inserted where missing and never overwriting what the
  // server already has. Then pull everything.
  async firstUpload() {
    const rows = allRows();
    const userId = Auth.userId;
    for (const table of Object.keys(TABLES)) {
      await this.upsert(table, rows[table], 'resolution=ignore-duplicates');
    }
    const sync = Store.data.sync;
    sync.pending = {}; // all of it was just uploaded
    sync.user = userId;
    sync.cursor = null;
    Store.save();
  },

  async push() {
    const pending = Store.data.sync.pending;
    for (const table of Object.keys(TABLES)) {
      const batch = Object.entries(pending).filter(([, p]) => p.table === table);
      if (!batch.length) continue;
      await this.upsert(table, batch.map(([, p]) => p.row), 'resolution=merge-duplicates');
      // Done, unless the row changed again while uploading
      for (const [key, p] of batch) {
        if (pending[key] && pending[key].row.updated_at === p.row.updated_at) delete pending[key];
      }
      Store.save();
    }
  },

  async upsert(table, rows, resolution) {
    const conflict = ['user_id', ...TABLES[table].key].join(',');
    for (let i = 0; i < rows.length; i += PAGE_SIZE) {
      const body = rows.slice(i, i + PAGE_SIZE).map((row) => ({ ...row, user_id: Auth.userId }));
      await rest(`${table}?on_conflict=${conflict}`, {
        method: 'POST',
        body,
        prefer: `${resolution},return=minimal`,
      });
    }
  },

  async pull() {
    const sync = Store.data.sync;
    const since = sync.cursor && new Date(Date.parse(sync.cursor) - PULL_OVERLAP_MS).toISOString();
    let cursor = sync.cursor;
    let changed = false;
    for (const [table, { order }] of Object.entries(TABLES)) {
      for (let offset = 0; ; offset += PAGE_SIZE) {
        const filter = since ? `&synced_at=gt.${encodeURIComponent(since)}` : '';
        const rows = await rest(
          `${table}?select=*${filter}&order=synced_at,${order}&limit=${PAGE_SIZE}&offset=${offset}`);
        for (const row of rows) {
          if (!cursor || newer(row.synced_at, cursor)) cursor = row.synced_at;
          const key = rowKey(table, row);
          const mine = sync.pending[key];
          if (mine && !newer(row.updated_at, mine.row.updated_at)) continue; // local change is newer
          delete sync.pending[key];
          applyRow(table, row);
          changed = true;
        }
        if (rows.length < PAGE_SIZE) break;
      }
    }
    sync.cursor = cursor;
    Store.save();
    if (changed) this.onChange();
  },

  init() {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.schedule();
    });
    window.addEventListener('online', () => this.schedule());
    window.addEventListener('pageshow', () => this.schedule());
    setInterval(() => {
      if (document.visibilityState === 'visible') this.schedule();
    }, PULL_EVERY_MS);
  },
};
