-- F8 — subscription tiers, and the limits they enforce (Phase 6).
--
-- The test plan is explicit that gating must hold against a direct API call,
-- not just a hidden button. So the limits live in triggers here, and the tier
-- itself is not client-writable: an app that could set its own tier would make
-- every other check theatre.

create table if not exists public.subscriptions (
  user_id uuid primary key references auth.users (id) on delete cascade,

  tier text not null default 'free'
    check (tier in ('free', 'pro', 'family', 'lifetime')),

  -- 'none' is the honest default: nobody has bought anything. 'manual' exists
  -- for support grants and for testing before RevenueCat is wired up.
  source text not null default 'none'
    check (source in ('none', 'revenuecat', 'manual')),

  -- Null for free and lifetime. Lifetime deliberately has no expiry: "for as
  -- long as TripVault operates as a service" is a business commitment, not a
  -- date on a row.
  expires_at timestamptz,

  -- RevenueCat's identifier for the entitlement, so a webhook can reconcile.
  external_id text,

  updated_at timestamptz not null default now(),

  constraint subscriptions_lifetime_never_expires
    check (tier <> 'lifetime' or expires_at is null)
);

alter table public.subscriptions enable row level security;

-- Read your own tier; write nothing. Writes come from the service role, which
-- is what a RevenueCat webhook will present. There is deliberately no INSERT or
-- UPDATE policy for authenticated users, and adding one would defeat the whole
-- feature.
drop policy if exists subscriptions_select_own on public.subscriptions;
create policy subscriptions_select_own on public.subscriptions
  for select using (user_id = auth.uid());

-- The tier in force -----------------------------------------------------------
--
-- Expiry is applied here rather than trusted from the row, so an expired
-- subscription is Free everywhere at once — including inside the triggers below.

create or replace function public.current_tier(uid uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case
    when s.tier is null then 'free'
    when s.tier = 'lifetime' then 'lifetime'
    when s.tier = 'free' then 'free'
    when s.expires_at is null then s.tier
    when s.expires_at > now() then s.tier
    else 'free'
  end
  from (select 1) dummy
  left join public.subscriptions s on s.user_id = uid;
$$;

-- Limits ----------------------------------------------------------------------
--
-- Kept in one function so the numbers exist in exactly two places: here and
-- lib/tiers.ts. scripts/verify-f8.mjs checks the two agree, because a silent
-- drift between them would mean the UI and the database disagree about what a
-- customer paid for.

create or replace function public.tier_traveler_limit(t text)
returns integer
language sql
immutable
as $$
  select case t
    when 'family' then 6
    else 1            -- free, pro and lifetime all get one profile
  end;
$$;

-- Null means unlimited.
create or replace function public.tier_active_trip_limit(t text)
returns integer
language sql
immutable
as $$
  select case t when 'free' then 1 else null end;
$$;

-- Enforcement -----------------------------------------------------------------

create or replace function public.enforce_traveler_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  tier text;
  limit_count integer;
  current_count integer;
begin
  tier := public.current_tier(new.user_id);
  limit_count := public.tier_traveler_limit(tier);

  select count(*) into current_count
    from public.travelers
   where user_id = new.user_id;

  if current_count >= limit_count then
    raise exception using
      errcode = 'check_violation',
      message = format(
        'Your %s plan covers %s traveler profile(s). Upgrade to add more.',
        tier, limit_count
      );
  end if;

  return new;
end;
$$;

drop trigger if exists travelers_enforce_tier_limit on public.travelers;
create trigger travelers_enforce_tier_limit
  before insert on public.travelers
  for each row execute function public.enforce_traveler_limit();

-- An "active" trip is one that has not finished. A trip with no end date counts
-- as active: it is being planned, which is exactly when the limit should bite.
create or replace function public.enforce_active_trip_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  tier text;
  limit_count integer;
  current_count integer;
begin
  tier := public.current_tier(new.user_id);
  limit_count := public.tier_active_trip_limit(tier);

  if limit_count is null then
    return new;  -- unlimited
  end if;

  -- A trip that has already finished does not consume an active-trip slot.
  -- Without this a Free user who has one upcoming trip cannot record a holiday
  -- they already took, which is not what "1 active trip" means and is a
  -- genuinely annoying way to meet a paywall.
  if new.end_date is not null and new.end_date < current_date then
    return new;
  end if;

  select count(*) into current_count
    from public.trips
   where user_id = new.user_id
     and (end_date is null or end_date >= current_date);

  if current_count >= limit_count then
    raise exception using
      errcode = 'check_violation',
      message = format(
        'Your %s plan covers %s active trip(s). Upgrade for unlimited trips.',
        tier, limit_count
      );
  end if;

  return new;
end;
$$;

drop trigger if exists trips_enforce_tier_limit on public.trips;
create trigger trips_enforce_tier_limit
  before insert on public.trips
  for each row execute function public.enforce_active_trip_limit();

-- Note on what is NOT enforced here:
--
-- Downgrading does not delete anything. If a Family plan lapses with four
-- profiles, all four remain — the trigger only refuses NEW inserts. Destroying
-- someone's records because a card expired would be indefensible, and the ToS
-- brief asks that the behaviour be stated rather than left to chance.
