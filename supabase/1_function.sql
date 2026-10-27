-- ==========================================================================
-- Jade! database, part 1 of 3: the "latest change wins" trigger function
-- Run the parts in order: 1_function.sql, 2_tables.sql, 3_security.sql.
-- Each part is safe to run again.
--
-- Every table uses this trigger (attached in part 3):
--   updated_at = when the change was made (set by the writer, even offline).
--   synced_at  = when the row reached the server (always set here). Clients
--                pull "everything with synced_at after my last sync".
--   An update carrying an OLDER updated_at than the stored row is skipped,
--   so a late upload from an offline phone can't overwrite a newer change.
--   An update that doesn't touch updated_at (e.g. a plain SQL UPDATE) is
--   stamped with now().
-- ==========================================================================

create or replace function public.jade_touch()
returns trigger
as $$
begin
  if tg_op = 'UPDATE' then
    if new.updated_at < old.updated_at then
      return null;
    end if;
    if new.updated_at = old.updated_at then
      new.updated_at := now();
    end if;
  end if;
  new.synced_at := now();
  return new;
end;
$$ language plpgsql;

-- Pin the search path (Supabase's security advisor asks for this)
alter function public.jade_touch() set search_path = '';
