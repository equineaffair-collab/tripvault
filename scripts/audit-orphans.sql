-- F12 — orphan audit.
--
-- Paste into the Supabase SQL editor. Every count must be zero.
--
-- scripts/verify-f12.mjs checks the same thing through the API, but that runs
-- under RLS, which HIDES a surviving row rather than revealing it. This query
-- runs as a superuser and so can actually see a record that outlived its owner.
-- Run it after any deletion work, and before launch.
--
-- log_rows_kept_after_delete is the one number that is allowed to be non-zero:
-- document_access_log.actor_user_id is ON DELETE SET NULL by design, so the
-- record that access happened outlives the account. That is the point of an
-- audit log.

select
  (select count(*) from public.travelers t
     left join auth.users u on u.id = t.user_id
    where u.id is null) as orphan_travelers,

  (select count(*) from public.documents d
     left join public.travelers t on t.id = d.traveler_id
    where t.id is null) as orphan_documents,

  (select count(*) from public.loyalty_programs l
     left join public.travelers t on t.id = l.traveler_id
    where t.id is null) as orphan_loyalty_programs,

  (select count(*) from public.trips tr
     left join auth.users u on u.id = tr.user_id
    where u.id is null) as orphan_trips,

  (select count(*) from public.trip_items i
     left join auth.users u on u.id = i.user_id
    where u.id is null) as orphan_trip_items,

  (select count(*) from public.trip_checklist_items c
     left join public.trips tr on tr.id = c.trip_id
    where tr.id is null) as orphan_checklist_items,

  (select count(*) from public.trip_travelers tt
     left join public.trips tr on tr.id = tt.trip_id
    where tr.id is null) as orphan_attendees_by_trip,

  (select count(*) from public.trip_travelers tt
     left join public.travelers t on t.id = tt.traveler_id
    where t.id is null) as orphan_attendees_by_traveler,

  -- Expected to be non-zero after any account deletion. See the note above.
  (select count(*) from public.document_access_log
    where actor_user_id is null) as log_rows_kept_after_delete;
