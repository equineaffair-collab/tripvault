-- F2 — schedule the daily expiry sweep.
--
-- NOT YET APPLIED. Needs one value that must not live in a committed file:
-- the sweep's shared secret. See the steps below.
--
-- The sweep itself is deployed and callable; this only automates it. Until this
-- runs, reminders are created whenever the function is invoked by hand, which
-- is what scripts/verify-f2.mjs does.

-- 1. Extensions. pg_cron schedules; pg_net makes the outbound HTTP call.
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

-- 2. Store the secret in Vault rather than inline, so it is not readable in
--    cron.job or in this file. Run once, with the value used for
--    `supabase secrets set REMINDER_SWEEP_SECRET=...`:
--
--    select vault.create_secret('<the same secret>', 'reminder_sweep_secret');
--
--    To rotate: update both the Vault secret and the function secret together,
--    or the sweep starts returning 401 and reminders quietly stop.

-- 3. The job. 07:00 UTC daily — early enough that a morning reminder lands
--    before most people start travelling, and outside the window when Supabase
--    runs its own maintenance.
--
--    Idempotent: unschedule first, so re-running this migration replaces the
--    job rather than creating a second one that would double every email.
select cron.unschedule('tripvault-daily-expiry-sweep')
 where exists (select 1 from cron.job where jobname = 'tripvault-daily-expiry-sweep');

select cron.schedule(
  'tripvault-daily-expiry-sweep',
  '0 7 * * *',
  $$
  select net.http_post(
    url := 'https://tkiluolwbhdcvjpiyzue.supabase.co/functions/v1/reminder-sweep',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-sweep-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'reminder_sweep_secret')
    ),
    body := '{}'::jsonb
  );
  $$
);

-- 4. Check it afterwards:
--    select jobname, schedule, active from cron.job;
--    select * from cron.job_run_details order by start_time desc limit 5;
--
-- The sweep is safe to run more than once a day: the unique index on
-- (ref_type, ref_id, milestone) means a second run in the same day cannot
-- produce a second reminder for the same milestone.
