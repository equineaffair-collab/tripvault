-- Verification for 0002_documents.sql (F1).
-- Run in the Supabase SQL editor. Wrapped in a transaction that always rolls
-- back, so it writes nothing permanent. Raises an exception on failure and
-- prints "ALL CHECKS PASSED" on success.
--
-- Requires at least one row in auth.users -- sign up in the app once first.
--
-- The RLS checks below switch to the `authenticated` role and impersonate a
-- real user id, because the SQL editor runs as a superuser that bypasses RLS
-- entirely. Testing these as the editor's default role would pass while
-- proving nothing.

begin;

do $$
declare
  test_user    uuid;
  test_trav    uuid;
  test_minor   uuid;
  test_doc     uuid;
  sample       text := 'v1.YWJjZGVmZ2hpams=.bG1ub3BxcnN0dXZ3eHl6';
  n            integer;
begin
  select id into test_user from auth.users order by created_at limit 1;
  if test_user is null then
    raise exception 'No auth.users rows yet -- sign up in the app once, then re-run.';
  end if;

  insert into public.travelers (user_id, name, relationship)
  values (test_user, 'Doc probe - adult', 'self')
  returning id into test_trav;

  insert into public.travelers (user_id, name, relationship)
  values (test_user, 'Doc probe - child', 'child')
  returning id into test_minor;

  -- 1. The encrypted column must refuse anything that is not an envelope. This
  --    is the backstop that makes storing a plaintext passport number a
  --    database error rather than a code review question.
  begin
    insert into public.documents (traveler_id, type, document_number_encrypted)
    values (test_trav, 'passport', 'L898902C3');
    raise exception 'FAIL: a plaintext document number was accepted';
  exception
    when check_violation then null;  -- expected
  end;

  -- 2. A well-formed envelope is accepted.
  insert into public.documents (traveler_id, type, country, document_number_encrypted, expiry_date)
  values (test_trav, 'passport', 'AUS', sample, '2032-01-15')
  returning id into test_doc;

  -- 3. Dual nationality: a second passport on the same traveler is fine...
  insert into public.documents (traveler_id, type, country, document_number_encrypted)
  values (test_trav, 'passport', 'LVA', sample);

  -- ...but only one of them may be primary.
  update public.documents set is_primary = true where id = test_doc;
  begin
    insert into public.documents (traveler_id, type, country, document_number_encrypted, is_primary)
    values (test_trav, 'passport', 'GBR', sample, true);
    raise exception 'FAIL: a second primary passport was accepted';
  exception
    when unique_violation then null;  -- expected
  end;

  -- 4. Dates must be ordered.
  begin
    insert into public.documents (traveler_id, type, document_number_encrypted, issue_date, expiry_date)
    values (test_trav, 'passport', sample, '2030-01-01', '2020-01-01');
    raise exception 'FAIL: an expiry before the issue date was accepted';
  exception
    when check_violation then null;  -- expected
  end;

  -- 5. A country code must look like an ICAO one.
  begin
    insert into public.documents (traveler_id, type, country, document_number_encrypted)
    values (test_trav, 'passport', 'Australia', sample);
    raise exception 'FAIL: a non-ICAO country code was accepted';
  exception
    when check_violation then null;  -- expected
  end;

  -- 6. F1's guardian gate has somewhere to record itself, and starts unset.
  perform 1 from public.travelers
   where id = test_minor and guardian_acknowledged_at is null;
  if not found then
    raise exception 'FAIL: guardian_acknowledged_at is missing or not null by default';
  end if;

  -- 7. Deleting a traveler must take their documents with it (F12 depends on
  --    this cascade actually existing, not on application code remembering).
  delete from public.travelers where id = test_trav;
  select count(*) into n from public.documents where traveler_id = test_trav;
  if n <> 0 then
    raise exception 'FAIL: % documents survived their traveler being deleted', n;
  end if;

  raise notice 'Constraint checks passed';
end $$;

-- ---------------------------------------------------------------------------
-- RLS: the client write path must be closed.
-- ---------------------------------------------------------------------------
do $$
declare
  test_user uuid;
  test_trav uuid;
  test_doc  uuid;
  sample    text := 'v1.YWJjZGVmZ2hpams=.bG1ub3BxcnN0dXZ3eHl6';
  n         integer;
begin
  select id into test_user from auth.users order by created_at limit 1;

  insert into public.travelers (user_id, name, relationship)
  values (test_user, 'RLS probe', 'self')
  returning id into test_trav;

  insert into public.documents (traveler_id, type, document_number_encrypted)
  values (test_trav, 'passport', sample)
  returning id into test_doc;

  -- Become the signed-in user, as PostgREST would.
  perform set_config('request.jwt.claims', json_build_object('sub', test_user)::text, true);
  perform set_config('role', 'authenticated', true);

  -- Read is allowed: the client needs metadata, and ciphertext is harmless.
  select count(*) into n from public.documents where id = test_doc;
  if n <> 1 then
    raise exception 'FAIL: the owner could not read their own document';
  end if;

  -- Insert must be refused. There is no INSERT policy, so the client cannot
  -- write a document at all -- everything goes through the Edge Function that
  -- holds the key. Without this, a direct API call could store a plaintext
  -- number dressed up in the envelope format.
  begin
    insert into public.documents (traveler_id, type, document_number_encrypted)
    values (test_trav, 'visa', sample);
    raise exception 'FAIL: the client was able to INSERT a document directly';
  exception
    when insufficient_privilege then null;  -- expected
  end;

  -- Update must be refused for the same reason.
  begin
    update public.documents
       set document_number_encrypted = 'v1.AAAA.BBBB'
     where id = test_doc;
    if found then
      raise exception 'FAIL: the client was able to UPDATE a document directly';
    end if;
  exception
    when insufficient_privilege then null;  -- expected
  end;

  -- The audit log must be readable but not writable or forgeable.
  begin
    insert into public.document_access_log (document_id, actor_user_id, action)
    values (test_doc, test_user, 'decrypt');
    raise exception 'FAIL: the client was able to write to the audit log';
  exception
    when insufficient_privilege then null;  -- expected
  end;

  perform set_config('role', 'postgres', true);
  raise notice 'RLS checks passed';
  raise notice 'ALL CHECKS PASSED';
end $$;

rollback;
