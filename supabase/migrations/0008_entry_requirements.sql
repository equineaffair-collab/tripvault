-- F6 — passport validity reference data (Phase 8).
--
-- Validity ONLY. There is deliberately no visa column: F6 answers "is my
-- passport valid enough", F7 answers "do I need a visa", and the feature plan's
-- design note explains at length why merging them was a mistake worth undoing.
-- A static visa flag goes stale in exactly the way that causes real harm.
--
-- ON THE SEED DATA BELOW -- read this before trusting any of it:
--
-- Every seeded row is marked `verified = false`. These are the widely-published
-- general rules, entered so the feature can be built and exercised; they are NOT
-- the outcome of the IATA Travel Centre lookups that
-- docs/tripvault-setup-steps.md assigns as manual research, and they are not
-- authoritative. Rules vary by nationality, by purpose of travel and by route,
-- and none of that nuance is captured here.
--
-- The app treats unverified rows differently on purpose, and the test plan
-- requires it: an unverified rule must never be presented as though it were
-- confirmed. Working through the starter list and flipping rows to
-- verified = true, with last_verified set, is a real task that remains open.

create table if not exists public.entry_requirements (
  -- ICAO 3-letter destination code. The primary key, since there is exactly one
  -- current rule per destination in this table.
  country text primary key check (country ~ '^[A-Z]{3}$'),

  country_name text not null,

  -- Months of validity required beyond the date of entry or departure. Zero
  -- means "valid for the duration of stay" -- a real rule, not a missing value.
  min_passport_validity_months integer not null
    check (min_passport_validity_months between 0 and 12),

  -- Whether the months are counted from arrival or from departure. The
  -- difference is the length of the trip, which matters for a long stay.
  counted_from text not null default 'entry'
    check (counted_from in ('entry', 'exit')),

  verified boolean not null default false,
  last_verified date,
  source text,
  notes text,

  updated_at timestamptz not null default now(),

  -- A row cannot claim to be verified without saying when. Without this, a
  -- verified flag set by hand and never dated would be indistinguishable from
  -- one confirmed years ago.
  constraint entry_requirements_verified_is_dated
    check (not verified or last_verified is not null)
);

-- Reference data: readable by any signed-in user, writable by nobody from the
-- client. Corrections go through a migration so they are reviewable, which is
-- the point of a dataset whose accuracy is the whole product.
alter table public.entry_requirements enable row level security;

drop policy if exists entry_requirements_read on public.entry_requirements;
create policy entry_requirements_read on public.entry_requirements
  for select to authenticated using (true);

-- Seed ----------------------------------------------------------------------
-- All unverified. See the note at the top of this file.

insert into public.entry_requirements
  (country, country_name, min_passport_validity_months, counted_from, verified, notes)
values
  ('THA', 'Thailand',       6, 'entry', false, 'Commonly published as six months beyond arrival. Needs IATA confirmation.'),
  ('IDN', 'Indonesia',      6, 'entry', false, 'Commonly published as six months beyond arrival. Needs IATA confirmation.'),
  ('SGP', 'Singapore',      6, 'entry', false, 'Commonly published as six months beyond arrival. Needs IATA confirmation.'),
  ('MYS', 'Malaysia',       6, 'entry', false, 'Commonly published as six months beyond arrival. Needs IATA confirmation.'),
  ('VNM', 'Vietnam',        6, 'entry', false, 'Commonly published as six months beyond arrival. Needs IATA confirmation.'),
  ('ARE', 'United Arab Emirates', 6, 'entry', false, 'Commonly published as six months beyond arrival. Needs IATA confirmation.'),
  ('CHN', 'China',          6, 'entry', false, 'Commonly published as six months beyond arrival. Needs IATA confirmation.'),
  ('IND', 'India',          6, 'entry', false, 'Commonly published as six months beyond arrival. Needs IATA confirmation.'),
  ('JPN', 'Japan',          0, 'exit',  false, 'Commonly published as valid for the duration of stay. Needs IATA confirmation.'),
  ('NZL', 'New Zealand',    1, 'exit',  false, 'Commonly published as one month beyond departure. Needs IATA confirmation.'),
  ('GBR', 'United Kingdom', 0, 'exit',  false, 'Commonly published as valid for the duration of stay. Needs IATA confirmation.'),
  ('USA', 'United States',  6, 'entry', false, 'Six months beyond stay, though widely waived for some nationalities. Needs IATA confirmation.'),
  ('FRA', 'France',         3, 'exit',  false, 'Schengen: commonly published as three months beyond intended departure. Needs IATA confirmation.'),
  ('ITA', 'Italy',          3, 'exit',  false, 'Schengen: commonly published as three months beyond intended departure. Needs IATA confirmation.'),
  ('ESP', 'Spain',          3, 'exit',  false, 'Schengen: commonly published as three months beyond intended departure. Needs IATA confirmation.'),
  ('DEU', 'Germany',        3, 'exit',  false, 'Schengen: commonly published as three months beyond intended departure. Needs IATA confirmation.'),
  ('GRC', 'Greece',         3, 'exit',  false, 'Schengen: commonly published as three months beyond intended departure. Needs IATA confirmation.'),
  ('LVA', 'Latvia',         3, 'exit',  false, 'Schengen: commonly published as three months beyond intended departure. Needs IATA confirmation.'),
  ('AUS', 'Australia',      0, 'exit',  false, 'Commonly published as valid for the duration of stay. Needs IATA confirmation.'),
  ('CAN', 'Canada',         0, 'exit',  false, 'Commonly published as valid for the duration of stay. Needs IATA confirmation.')
on conflict (country) do nothing;
