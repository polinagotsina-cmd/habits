-- ==========================================================================
-- Jade! database, part 4: goals as mini plans
-- Run once in the Supabase SQL Editor, after parts 1-3. Safe to run again.
-- It only adds columns (with defaults); no existing row is changed.
--
-- A goal is a row in todos with list = 'goals' and parent_id = null. Its
-- blocks (text lines and tasks) are rows with list = 'goals' and parent_id
-- = the goal's id, shown in position order. New columns:
--   type    'task' (has a checkbox) or 'text' (a plain line). Existing rows
--           become 'task', which is what they already were.
--   weight  'thin' or 'regular' (regular = a sub-heading such as "Phase 1").
--   done_at the moment a task was checked (done_on is its day). The app
--           lists checked tasks latest first, and a goal gets done_on and
--           done_at when all its tasks are checked.
-- ==========================================================================

alter table public.todos add column if not exists type text not null default 'task';
alter table public.todos add column if not exists weight text not null default 'thin';
alter table public.todos add column if not exists done_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint
                 where conname = 'todos_type_check' and conrelid = 'public.todos'::regclass) then
    alter table public.todos add constraint todos_type_check check (type in ('task', 'text'));
  end if;
  if not exists (select 1 from pg_constraint
                 where conname = 'todos_weight_check' and conrelid = 'public.todos'::regclass) then
    alter table public.todos add constraint todos_weight_check check (weight in ('thin', 'regular'));
  end if;
end;
$$;

-- For reading a goal's blocks in order
create index if not exists todos_parent_idx on public.todos (user_id, parent_id, position);

-- Make the API see the new columns right away
notify pgrst, 'reload schema';
