-- ==========================================================================
-- Jade! database, part 7: open nights and several moods per day
-- Run once in the Supabase SQL Editor, after part 6. Safe to run again.
--
-- sleep: a night can be saved with only its bedtime (wake_time = null, an
--        "open" night) and filled in later. Both times null = the night was
--        deleted (rows are kept, like everywhere else).
-- mood:  several entries per day, each with its own id and time of day.
--        Existing moods are kept: each becomes one entry with id = its date.
--        Its time is when it was saved (Tbilisi time) if that was the same
--        day, otherwise unknown (null).
-- ==========================================================================

-- sleep --------------------------------------------------------------------
alter table public.sleep alter column bedtime drop not null;
alter table public.sleep alter column wake_time drop not null;
alter table public.sleep drop constraint if exists sleep_wake_needs_bed_check;
alter table public.sleep add constraint sleep_wake_needs_bed_check
  check (wake_time is null or bedtime is not null);

-- mood ---------------------------------------------------------------------
alter table public.mood add column if not exists id text;
alter table public.mood add column if not exists "time" time;
alter table public.mood add column if not exists deleted boolean not null default false;

-- Existing rows (one per day so far): id = the date. updated_at is changed
-- by the trigger too, so the apps pull the new shape on their next sync.
update public.mood
set id = date::text,
    "time" = case
      when (updated_at at time zone 'Asia/Tbilisi')::date = date
      then date_trunc('minute', updated_at at time zone 'Asia/Tbilisi')::time
    end
where id is null;

alter table public.mood alter column id set not null;

-- The key was (user_id, date); now it's (user_id, id)
alter table public.mood drop constraint if exists mood_pkey;
alter table public.mood add constraint mood_pkey primary key (user_id, id);
create index if not exists mood_date_idx on public.mood (user_id, date);

-- Make the API see the new columns right away
notify pgrst, 'reload schema';
