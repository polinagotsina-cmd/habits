# Jade! database

Jade! keeps its data in Supabase (Postgres). The app works from a local copy and syncs it. Other clients, such as the Friday bot, read and write the same tables. The schema is in [`supabase/`](../supabase/): run `1_function.sql`, `2_tables.sql`, `3_security.sql`, then `4_goals.sql`.

## Connecting

- **Project URL and publishable (anon) key:** the same ones as in `sync.js`.
- **Sign in as the user** (email + password) and use that session for every request. Row Level Security only shows a logged-in user their own rows. Without a login you see nothing.
  ```python
  from supabase import create_client
  sb = create_client(URL, PUBLISHABLE_KEY)
  sb.auth.sign_in_with_password({"email": EMAIL, "password": PASSWORD})
  sb.table("habit_checks").select("*").eq("date", "2026-10-27").execute()
  ```
- **The secret/service_role key** skips RLS. If a server-side script on your own machine uses it anyway, it must set `user_id` itself. Never put it in the app or in git.

## Rules for writers

1. **Upsert, don't hard-delete.** Mark rows instead: `done = false`, `note = null` and `deleted = true`. Then other devices see the change when they sync.
2. **Set `updated_at = now()` on every write.** It's how "latest change wins" works: the server ignores an update whose `updated_at` is older than the stored row. If you leave it out, a plain update is stamped with `now()` anyway.
3. **Leave `synced_at` alone.** The server sets it. Clients pull rows with `synced_at` after their last pull.
4. **Ids are text.** Use your own unique strings for new rows. A random UUID is fine.
5. Every row has `user_id` (uuid, defaults to the logged-in user). All primary keys start with it.

The app pulls changes when it opens, when it comes back to the foreground, when it reconnects, and every 5 minutes while open.

## Tables

### `habits`: the habit list
| column | type | |
|---|---|---|
| `id` | text | key, e.g. `sport`, `language`, `blog`, `design`, `smartass` |
| `name` | text | shown in the app, e.g. `Blog/Clients` |
| `position` | float | display order, ascending |
| `archived` | bool | hidden in the app; its history stays |

### `habit_checks`: a habit done on a day
| column | type | |
|---|---|---|
| `habit_id` | text | → `habits.id` |
| `date` | date | local calendar day, `YYYY-MM-DD` |
| `done` | bool | `false` = unchecked (rows are kept) |

Key: (`user_id`, `habit_id`, `date`). A missing row means not done.

### `habit_notes`: the note under a habit
| column | type | |
|---|---|---|
| `habit_id` | text | → `habits.id` |
| `date` | date | the day the note was written |
| `note` | text | `null` = no note of its own that day; `''` = cleared that day |

A note carries over to later days until the day after the habit is done. To find the note shown on day D, walk back from D:
- the first day that has its own note (`note` not null) wins;
- stop with no note if the habit was done on the day before the one you're checking.

### `todos`: to-do items
| column | type | |
|---|---|---|
| `id` | text | key |
| `list` | text | `today`, `longterm` or `goals` |
| `parent_id` | text, null | `null` for to-dos and goals; for a goal's block: the goal's `id` |
| `text` | text | shown without any prefix |
| `type` | text | `task` (has a checkbox) or `text` (a plain line). Default `task` |
| `weight` | text | `thin` or `regular` (a sub-heading, e.g. "Phase 1"). Default `thin` |
| `position` | float | order among its siblings (same `list` and `parent_id`), ascending |
| `created_on` | date | |
| `done_on` | date, null | day it was checked; `null` = open |
| `done_at` | timestamptz, null | moment it was checked; set it together with `done_on` |
| `deleted` | bool | removed by the user |

**Today and Long term** (`list` = `today` / `longterm`): checked items are listed first, latest `done_at` first, then the open ones by `position`. The app shows a checked item until the end of its `done_on` day. After that, it disappears from the app but stays in the table as history. To add a task, insert a row with a new `id`, `deleted = false`, `done_on = null`, and a `position` greater than the others in its list.

### Goals and their steps
Goals live in `todos` too, with `list = 'goals'`:
- **A goal** is a row with `parent_id = null`. Its `text` is the headline. `type` and `weight` don't matter for it.
- **Its blocks** are rows with `parent_id` = the goal's `id`, shown under it in `position` order:

  | what it looks like | `type` | `weight` | typed in the app as |
  |---|---|---|---|
  | a task with a checkbox | `task` | `thin` | `[] Book the exam` |
  | a sub-heading (phase) | `text` | `regular` | `# Phase 1` |
  | a plain note line | `text` | `thin` | `Milan · Sep 2027` |

  Phases are just `regular` text lines: a task "belongs" to the phase above it in `position` order.
- **A goal is done** when it has at least one task and all its tasks are checked. The app then sets the goal's `done_on`/`done_at`, and puts it at the top, struck through. It stays there; unchecking a task clears them again. A goal without tasks is never done. Don't set a goal's `done_on` yourself: check its tasks.
- Goals and their blocks never disappear by date. (Old goals checked before blocks existed have `done_on` but no `done_at`; they disappear the next day like to-dos.)

To **add a step** to a goal, insert a block:
```python
sb.table("todos").insert({
    "id": str(uuid.uuid4()), "list": "goals", "parent_id": GOAL_ID,
    "type": "task", "weight": "thin", "text": "Book the exam",
    "position": LAST_POSITION + 1,  # max position among the goal's blocks, + 1
    "created_on": "2026-10-28", "deleted": False,
}).execute()
```
To put it between two blocks, use the average of their positions. To check a task, update `done_on` (the day) and `done_at` (now) along with `updated_at`.

### Common columns
| column | type | |
|---|---|---|
| `user_id` | uuid | owner (→ `auth.users`) |
| `updated_at` | timestamptz | when the change was made; latest wins |
| `synced_at` | timestamptz | when the row last reached the server (set by the server) |
