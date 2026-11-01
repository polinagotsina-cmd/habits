-- ==========================================================================
-- Jade! database, part 6: two more moods, "okay" and "meh"
-- Run once in the Supabase SQL Editor, after part 5. Safe to run again.
-- Only widens the list of allowed values; no existing row changes.
-- ==========================================================================

alter table public.mood drop constraint if exists mood_mood_check;
alter table public.mood add constraint mood_mood_check
  check (mood in ('happy', 'okay', 'meh', 'calm', 'sad', 'angry', 'anxious', 'tired'));

notify pgrst, 'reload schema';
