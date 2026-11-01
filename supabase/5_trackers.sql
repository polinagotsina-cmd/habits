-- ==========================================================================
-- Jade! database, part 5: sleep and mood trackers
-- Run once in the Supabase SQL Editor, after parts 1-4. Safe to run again.
-- One row per day in each table. Same rules as the other tables: the
-- jade_touch trigger (latest change wins, synced_at set by the server) and
-- Row Level Security (a logged-in user sees only their own rows).
-- ==========================================================================

-- A night of sleep, filed under the day of waking up.
-- If wake_time is earlier than bedtime, the wake-up is on the next day:
-- bedtime 23:15 + wake_time 07:30 on date 2026-11-07 = Nov 6 23:15 -> Nov 7 07:30.
create table if not exists public.sleep (
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  date       date not null,  -- the day of waking up
  bedtime    time not null,  -- local time, e.g. 23:15
  wake_time  time not null,  -- local time, e.g. 07:30
  updated_at timestamptz not null default now(),
  synced_at  timestamptz not null default now(),
  primary key (user_id, date),
  -- 0 minutes and more than 20 hours are rejected by the app too
  constraint sleep_length_check check (bedtime <> wake_time)
);

-- The mood of a day: one per day.
create table if not exists public.mood (
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  date       date not null,
  mood       text not null,
  updated_at timestamptz not null default now(),
  synced_at  timestamptz not null default now(),
  primary key (user_id, date),
  constraint mood_mood_check check (mood in ('happy', 'calm', 'sad', 'angry', 'anxious', 'tired'))
);

-- For "everything changed since my last sync"
create index if not exists sleep_sync_idx on public.sleep (user_id, synced_at);
create index if not exists mood_sync_idx on public.mood (user_id, synced_at);

-- sleep
drop trigger if exists jade_touch on public.sleep;
create trigger jade_touch before insert or update on public.sleep
  for each row execute function public.jade_touch();
alter table public.sleep enable row level security;
drop policy if exists "Own rows only" on public.sleep;
create policy "Own rows only" on public.sleep for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
revoke all on public.sleep from anon;
grant select, insert, update, delete on public.sleep to authenticated;

-- mood
drop trigger if exists jade_touch on public.mood;
create trigger jade_touch before insert or update on public.mood
  for each row execute function public.jade_touch();
alter table public.mood enable row level security;
drop policy if exists "Own rows only" on public.mood;
create policy "Own rows only" on public.mood for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
revoke all on public.mood from anon;
grant select, insert, update, delete on public.mood to authenticated;

-- Make the API see the new tables right away
notify pgrst, 'reload schema';
