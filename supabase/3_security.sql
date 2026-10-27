-- ==========================================================================
-- Jade! database, part 3 of 3: triggers and security
-- For each table:
--   1. attach the trigger from part 1;
--   2. turn on Row Level Security with one policy: a logged-in user reads
--      and writes only rows with their own user_id;
--   3. no access for anyone not logged in (anon), full access for logged-in
--      users (still limited to their own rows by the policy).
-- ==========================================================================

-- habits
drop trigger if exists jade_touch on public.habits;
create trigger jade_touch before insert or update on public.habits
  for each row execute function public.jade_touch();
alter table public.habits enable row level security;
drop policy if exists "Own rows only" on public.habits;
create policy "Own rows only" on public.habits for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
revoke all on public.habits from anon;
grant select, insert, update, delete on public.habits to authenticated;

-- habit_checks
drop trigger if exists jade_touch on public.habit_checks;
create trigger jade_touch before insert or update on public.habit_checks
  for each row execute function public.jade_touch();
alter table public.habit_checks enable row level security;
drop policy if exists "Own rows only" on public.habit_checks;
create policy "Own rows only" on public.habit_checks for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
revoke all on public.habit_checks from anon;
grant select, insert, update, delete on public.habit_checks to authenticated;

-- habit_notes
drop trigger if exists jade_touch on public.habit_notes;
create trigger jade_touch before insert or update on public.habit_notes
  for each row execute function public.jade_touch();
alter table public.habit_notes enable row level security;
drop policy if exists "Own rows only" on public.habit_notes;
create policy "Own rows only" on public.habit_notes for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
revoke all on public.habit_notes from anon;
grant select, insert, update, delete on public.habit_notes to authenticated;

-- todos
drop trigger if exists jade_touch on public.todos;
create trigger jade_touch before insert or update on public.todos
  for each row execute function public.jade_touch();
alter table public.todos enable row level security;
drop policy if exists "Own rows only" on public.todos;
create policy "Own rows only" on public.todos for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
revoke all on public.todos from anon;
grant select, insert, update, delete on public.todos to authenticated;
