-- ==========================================================================
-- Jade! database, part 2 of 3: tables and indexes
-- Every row belongs to a user (user_id); ids are text so the app can create
-- them offline. Nothing is hard-deleted by the app: checks become
-- done = false, notes note = null, to-dos deleted = true.
-- ==========================================================================

-- The habit list, in display order. Archived habits are hidden in the app
-- but their history stays.
create table if not exists public.habits (
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id         text not null,
  name       text not null,
  position   double precision not null default 0,
  archived   boolean not null default false,
  updated_at timestamptz not null default now(),
  synced_at  timestamptz not null default now(),
  primary key (user_id, id)
);

-- One row per habit per day that was ever checked.
create table if not exists public.habit_checks (
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  habit_id   text not null,
  date       date not null,
  done       boolean not null default true,
  updated_at timestamptz not null default now(),
  synced_at  timestamptz not null default now(),
  primary key (user_id, habit_id, date),
  foreign key (user_id, habit_id) references public.habits (user_id, id) on delete cascade
);

-- A note written on a given day; it carries over to later days until the
-- habit is done (the app works that out). note = null: no note of its own
-- that day; note = '': cleared that day.
create table if not exists public.habit_notes (
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  habit_id   text not null,
  date       date not null,
  note       text,
  updated_at timestamptz not null default now(),
  synced_at  timestamptz not null default now(),
  primary key (user_id, habit_id, date),
  foreign key (user_id, habit_id) references public.habits (user_id, id) on delete cascade
);

-- To-do items in three lists. parent_id is ready for goal sub-tasks.
create table if not exists public.todos (
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id         text not null,
  list       text not null check (list in ('today', 'longterm', 'goals')),
  parent_id  text,
  text       text not null,
  position   double precision not null default 0,
  created_on date not null default current_date,
  done_on    date,
  deleted    boolean not null default false,
  updated_at timestamptz not null default now(),
  synced_at  timestamptz not null default now(),
  primary key (user_id, id),
  foreign key (user_id, parent_id) references public.todos (user_id, id)
    on delete cascade deferrable initially deferred
);

-- For "what changed since my last sync"
create index if not exists habits_sync_idx on public.habits (user_id, synced_at);
create index if not exists habit_checks_sync_idx on public.habit_checks (user_id, synced_at);
create index if not exists habit_notes_sync_idx on public.habit_notes (user_id, synced_at);
create index if not exists todos_sync_idx on public.todos (user_id, synced_at);
