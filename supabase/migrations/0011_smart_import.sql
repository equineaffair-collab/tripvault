-- F5 — smart import (Phase 9): forwarded emails and scanned bookings.
--
-- Two paths, one destination. A photo scanned inside a trip lands in that trip;
-- a forwarded email cannot know which trip it belongs to, so it lands in the
-- "Needs a trip" holding area that trip_items.trip_id has been nullable for
-- since 0004. That column was made nullable then precisely so this migration
-- would not have to retrofit it onto a table holding real bookings.

-- ---------------------------------------------------------------------------
-- The forwarding address
-- ---------------------------------------------------------------------------
-- F5 is explicit that the address IS the access control: anything arriving
-- there is treated as that user's, with no verification at forward-time,
-- because the user is inside their own mail client at that moment and there is
-- nothing to authenticate against. So it is a credential, and gets a
-- credential's treatment -- unguessable, not enumerable, and replaceable.
--
-- Deviation from the feature plan's example, on purpose: the plan illustrates
-- "janette-8f3k@trips.tripvaultapp.com". The name half is dropped here. This
-- address travels in mail headers, through spam filters and along forwarded
-- chains, so a readable name leaks who the account holder is to everyone who
-- handles the message -- and buys nothing, since the app shows the address with
-- a copy button rather than asking anyone to recognise it.

create table if not exists public.forwarding_addresses (
  user_id uuid primary key references auth.users (id) on delete cascade,

  -- The part before the @. All entropy, no meaning.
  local_part text not null unique
    check (local_part ~ '^tv[0-9a-z]{24}$'),

  created_at timestamptz not null default now(),
  rotated_at timestamptz
);

alter table public.forwarding_addresses enable row level security;

-- Read your own, and nothing else. There is deliberately no policy that would
-- let one account discover another's: an enumerable list of these would be a
-- list of working credentials.
drop policy if exists forwarding_addresses_select_own on public.forwarding_addresses;
create policy forwarding_addresses_select_own on public.forwarding_addresses
  for select using (user_id = auth.uid());

-- Issued and rotated by the `smart-import` Edge Function with the service role,
-- because the local part must come from a CSPRNG the client does not have and
-- must not be chosen by the caller. No INSERT or UPDATE policy here.
--
-- DELETE is allowed: turning the feature off by destroying the address should
-- never depend on a server being reachable.
drop policy if exists forwarding_addresses_delete_own on public.forwarding_addresses;
create policy forwarding_addresses_delete_own on public.forwarding_addresses
  for delete using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- What arrived
-- ---------------------------------------------------------------------------
-- Without this table a forwarded email that could not be read is simply
-- invisible: the user forwards a confirmation, nothing appears, and there is
-- no way to tell whether it was lost, ignored or misread. F5's whole Path B is
-- asynchronous, so the record of "we received this and here is what happened"
-- is the feature, not bookkeeping.

create table if not exists public.inbound_emails (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,

  from_address text,
  subject text,
  received_at timestamptz not null default now(),

  status text not null default 'pending'
    check (status in ('pending', 'extracted', 'unreadable', 'rejected_tier', 'failed')),

  -- Why, in the user's words, when the status alone is not enough.
  detail text,

  -- The item this became, if it became one. SET NULL rather than cascade: the
  -- record that an email arrived should outlive the booking it created, or
  -- deleting a mistaken import would erase the evidence of the mistake.
  trip_item_id uuid references public.trip_items (id) on delete set null,

  -- The plain-text body, capped. Kept ONLY so that a message which arrives
  -- while no extraction provider is configured can be read later rather than
  -- lost -- which is the state this project is actually in, and the same trade
  -- F2 makes by recording a reminder as owed before it can be delivered.
  --
  -- It is the user's own mail content, so: they can read it, they can delete
  -- it, it goes with their account, and nothing else in the app reads it.
  body_text text check (body_text is null or length(body_text) <= 20000),

  created_at timestamptz not null default now()
);

create index if not exists inbound_emails_user_idx
  on public.inbound_emails (user_id, received_at desc);

alter table public.inbound_emails enable row level security;

drop policy if exists inbound_emails_select_own on public.inbound_emails;
create policy inbound_emails_select_own on public.inbound_emails
  for select using (user_id = auth.uid());

-- Deleting is how a user clears mail content they would rather not have stored.
drop policy if exists inbound_emails_delete_own on public.inbound_emails;
create policy inbound_emails_delete_own on public.inbound_emails
  for delete using (user_id = auth.uid());

-- Written only by the inbound webhook, with the service role. A client that
-- could insert here could fabricate "an email arrived", which is not a
-- meaningful attack but is a meaningless capability, so it is not granted.

-- ---------------------------------------------------------------------------
-- Mail arriving for an address that does not exist
-- ---------------------------------------------------------------------------
-- Not recorded at all, deliberately. There is no user to own the row, and
-- storing the content of unsolicited mail sent to a non-existent address would
-- mean collecting messages from and about people who have no relationship with
-- this app. The webhook counts it and drops it.

-- ---------------------------------------------------------------------------
-- The holding area
-- ---------------------------------------------------------------------------
-- trip_items.trip_id is already nullable with user_id alongside it, and
-- 0004 already indexes the null case. What is missing is the guarantee that an
-- unassigned item always has an owner -- RLS scopes on user_id, so an item with
-- neither a trip nor a user would be invisible and unreachable forever.
-- user_id is NOT NULL there, so that holds; this states it as an assertion
-- rather than leaving it to be rediscovered.

do $$
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'trip_items'
       and column_name = 'user_id' and is_nullable = 'YES'
  ) then
    raise exception 'trip_items.user_id must stay NOT NULL: an unassigned item needs an owner';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Tier gate (F8)
-- ---------------------------------------------------------------------------
-- Smart import is the one feature with a real per-use cost, which is why the
-- feature plan singles it out as worth gating on cost grounds. Enforced on the
-- write, so a direct API call cannot create an extracted item on a Free plan.
--
-- Only 'photo' and 'email' are gated. 'manual' and 'link' cost nothing and are
-- available on every tier -- gating those would be gating the app itself.

create or replace function public.enforce_smart_import()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if new.source in ('photo', 'email')
     and not public.tier_has_feature(public.current_tier(new.user_id), 'smart_import') then
    raise exception using
      errcode = 'check_violation',
      message = 'Smart import is part of Pro. Bookings can still be added by hand on any plan.';
  end if;
  return new;
end;
$fn$;

drop trigger if exists trip_items_enforce_smart_import on public.trip_items;
create trigger trip_items_enforce_smart_import
  before insert on public.trip_items
  for each row execute function public.enforce_smart_import();
