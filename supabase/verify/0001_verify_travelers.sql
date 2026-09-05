-- Verification for 0001_travelers.sql (F11).
-- Run in the Supabase SQL editor. Wrapped in a transaction that always rolls
-- back, so it writes nothing permanent. Raises an exception on failure and
-- prints "ALL CHECKS PASSED" on success.
--
-- Requires at least one row in auth.users -- sign up in the app once first.

begin;

do $$
declare
  test_user uuid;
  got_minor boolean;
begin
  select id into test_user from auth.users order by created_at limit 1;
  if test_user is null then
    raise exception 'No auth.users rows yet -- sign up in the app once, then re-run.';
  end if;

  -- 1. A "child" profile must come back is_minor = true even though the
  --    insert explicitly claims false. This is the check that matters: F1
  --    gates its parent/guardian acknowledgment on this flag, so a client
  --    lying about it must not be able to bypass that gate.
  insert into public.travelers (user_id, name, relationship, is_minor)
  values (test_user, 'Trigger probe - child', 'child', false)
  returning is_minor into got_minor;

  if got_minor is not true then
    raise exception 'FAIL: child profile stored is_minor = %, expected true', got_minor;
  end if;

  -- 2. A non-child profile must be false even if the insert claims true.
  insert into public.travelers (user_id, name, relationship, is_minor)
  values (test_user, 'Trigger probe - adult', 'partner', true)
  returning is_minor into got_minor;

  if got_minor is not false then
    raise exception 'FAIL: partner profile stored is_minor = %, expected false', got_minor;
  end if;

  -- 3. Changing relationship must re-derive the flag, not leave it stale.
  update public.travelers
     set relationship = 'child'
   where name = 'Trigger probe - adult' and user_id = test_user
  returning is_minor into got_minor;

  if got_minor is not true then
    raise exception 'FAIL: after update to child, is_minor = %, expected true', got_minor;
  end if;

  -- 4. Updating ONLY is_minor must not be able to forge it. This is the case
  --    a column-scoped `update of relationship` trigger misses entirely: the
  --    trigger never fires, so the client's value sticks. RLS allows this write
  --    on the user's own row, so it is reachable by any direct API call.
  update public.travelers
     set is_minor = false
   where name = 'Trigger probe - child' and user_id = test_user
  returning is_minor into got_minor;

  if got_minor is not true then
    raise exception 'FAIL: is_minor was forged to % by a direct update, expected true', got_minor;
  end if;

  -- 5. The relationship CHECK constraint must reject anything off-list.
  begin
    insert into public.travelers (user_id, name, relationship)
    values (test_user, 'Trigger probe - bad', 'grandparent');
    raise exception 'FAIL: relationship = grandparent was accepted, expected rejection';
  exception
    when check_violation then null;  -- expected
  end;

  raise notice 'ALL CHECKS PASSED';
end $$;

rollback;
