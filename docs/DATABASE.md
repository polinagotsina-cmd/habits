# Jade! database

Jade! keeps its data in Supabase (Postgres). The app works from a local copy and syncs it. Other clients, such as the Friday bot, read and write the same tables. The schema is in [`supabase/`](../supabase/): run `1_function.sql`, `2_tables.sql`, then `3_security.sql`.

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
| `parent_id` | text, null | for goal sub-tasks: the goal's `id` (not used by the app yet) |
| `text` | text | |
| `position` | float | order within the list, ascending |
| `created_on` | date | |
| `done_on` | date, null | day it was checked; `null` = open |
| `deleted` | bool | removed by the user |

The app shows a checked item until the end of its `done_on` day. After that, it disappears from the app but stays in the table as history. To add a task, insert a row with a new `id`, `deleted = false`, `done_on = null`, and a `position` greater than the others in its list.

### Common columns
| column | type | |
|---|---|---|
| `user_id` | uuid | owner (→ `auth.users`) |
| `updated_at` | timestamptz | when the change was made; latest wins |
| `synced_at` | timestamptz | when the row last reached the server (set by the server) |
