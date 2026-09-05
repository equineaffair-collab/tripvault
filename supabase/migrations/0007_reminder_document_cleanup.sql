-- F2 — remove a document's reminders when the document goes.
--
-- reminders.ref_id deliberately has no foreign key: ref_type makes the table
-- generic, so F8's payment-due reminders can reuse it rather than getting a
-- table of their own. The cost of that genericity is that Postgres cannot
-- cascade for us, and verify-f2 caught the consequence -- deleting a document
-- left its reminders behind as orphans.
--
-- A trigger restores integrity without giving up the generic shape. When a
-- second ref_type is added, it needs its own trigger alongside this one, and
-- scripts/audit-orphans.sql should grow a matching check.

create or replace function public.delete_reminders_for_document()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.reminders
   where ref_type = 'document'
     and ref_id = old.id;
  return old;
end;
$$;

drop trigger if exists documents_delete_reminders on public.documents;
create trigger documents_delete_reminders
  after delete on public.documents
  for each row execute function public.delete_reminders_for_document();
