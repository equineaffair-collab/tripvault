-- F9 — family member access (Phase 10).
--
-- Two mechanisms for two different problems, kept structurally apart because
-- they have different security models. The prompt is explicit that this must
-- not become one code path with a branch, so the separation is enforced by the
-- shape of the schema rather than by discipline:
--
--   1. LINKED LOGIN — a traveler profile gains its own auth user. Access is
--      granted by ROW LEVEL SECURITY, select-only, evaluated on every query.
--      The linked person is a real account holder.
--
--   2. ONE-OFF SHARE LINK — a genuine outsider with no account at all. There
--      is deliberately NO RLS PATH for this: `anon` gets no policy on any
--      table here. The only way to read a shared trip is the `shared-trip`
--      Edge Function holding the service role. So "documents are excluded
--      unless toggled on" is one branch in one function, not a policy anyone
--      could weaken by accident.
--
-- Tokens are stored as SHA-256 hashes, never in the clear. A leaked backup of
-- this database must not yield working invite or share links -- the token is a
-- bearer credential, so it gets the same treatment a password would.

-- ---------------------------------------------------------------------------
-- Tier gate (F8)
-- ---------------------------------------------------------------------------
-- F9 is Family-only per the feature plan's tier table: it only makes sense once
-- there is more than one traveler profile to link. Encoded here as well as in
-- lib/tiers.ts, and scripts/verify-f9.mjs asserts the two agree -- the same
-- treatment F8's limits get, for the same reason.

create or replace function public.tier_has_feature(t text, f text)
returns boolean
language sql
immutable
as $fn$
  select case f
    when 'smart_import'     then t in ('pro', 'family', 'lifetime')
    when 'validity_checker' then t in ('pro', 'family', 'lifetime')
    when 'trip_sharing'     then t = 'family'
    else false
  end;
$fn$;

-- ---------------------------------------------------------------------------
-- Who a linked user is, without recursing through RLS
-- ---------------------------------------------------------------------------
-- The policies below need "which travelers is this auth user linked to" and
-- "which trips do those travelers attend". Inlining those as subqueries would
-- make every policy re-evaluate `travelers` under ITS policies, which is both
-- slow and a recursion hazard once more policies reference each other. A
-- security-definer helper resolves it once, in one place.

create or replace function public.linked_traveler_ids(uid uuid)
returns setof uuid
language sql
stable
security definer
set search_path = public
as $fn$
  select id from public.travelers
   where uid is not null and linked_auth_user_id = uid;
$fn$;

create or replace function public.linked_trip_ids(uid uuid)
returns setof uuid
language sql
stable
security definer
set search_path = public
as $fn$
  select distinct tt.trip_id
    from public.trip_travelers tt
   where tt.traveler_id in (select public.linked_traveler_ids(uid));
$fn$;

-- ===========================================================================
-- MECHANISM 1 — linked login
-- ===========================================================================

create table if not exists public.traveler_invites (
  id uuid primary key default gen_random_uuid(),
  traveler_id uuid not null references public.travelers (id) on delete cascade,
  created_by uuid not null references auth.users (id) on delete cascade,

  -- SHA-256 of the invite code, lowercase hex. The code itself is generated on
  -- the organizer's device and shown to them once; the server never sees it.
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),

  created_at timestamptz not null default now(),
  expires_at timestamptz not null,

  accepted_at timestamptz,
  accepted_by uuid references auth.users (id) on delete set null,

  -- An accepted invite has both or neither. Half-accepted is not a state.
  constraint traveler_invites_accept_pair
    check ((accepted_at is null) = (accepted_by is null))
);

create index if not exists traveler_invites_traveler_idx
  on public.traveler_invites (traveler_id);

-- At most one invite outstanding per profile. Regenerating deletes and
-- re-issues, so an organizer cannot leave a trail of live codes behind them --
-- each one is a bearer credential for that person's passport.
create unique index if not exists traveler_invites_one_pending
  on public.traveler_invites (traveler_id)
  where accepted_at is null;

-- ---------------------------------------------------------------------------
-- Guards enforced in the database, so a direct API call cannot walk past them
-- ---------------------------------------------------------------------------

create or replace function public.check_traveler_invite()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  owner_id uuid;
  minor boolean;
  linked uuid;
begin
  select t.user_id, t.is_minor, t.linked_auth_user_id
    into owner_id, minor, linked
    from public.travelers t
   where t.id = new.traveler_id;

  if owner_id is null then
    raise exception using errcode = 'foreign_key_violation',
      message = 'That traveler profile does not exist.';
  end if;

  if owner_id <> new.created_by then
    raise exception using errcode = 'insufficient_privilege',
      message = 'You can only invite your own traveler profiles.';
  end if;

  if not public.tier_has_feature(public.current_tier(new.created_by), 'trip_sharing') then
    raise exception using errcode = 'check_violation',
      message = 'Family member access is part of the Family plan.';
  end if;

  -- A minor is not given their own login. The feature plan describes this
  -- mechanism for "a husband, a son" -- an adult family member who manages
  -- their own travel day. Handing a child their own account holding their own
  -- passport is a different product with a different regulatory footprint: the
  -- plan already flags the Australian Children's Online Privacy Code (register
  -- by 10 December 2026) as applying to this app. Refusing is the conservative
  -- default and is trivially reversible if that is not what you want; the
  -- reverse -- discovering child accounts already exist -- is not.
  if minor then
    raise exception using errcode = 'check_violation',
      message = 'A profile marked as a child cannot be given its own login.';
  end if;

  if linked is not null then
    raise exception using errcode = 'unique_violation',
      message = 'That profile already has its own login. Revoke it first.';
  end if;

  return new;
end;
$fn$;

drop trigger if exists traveler_invites_check on public.traveler_invites;
create trigger traveler_invites_check
  before insert on public.traveler_invites
  for each row execute function public.check_traveler_invite();

-- A traveler profile must never be linked to the account that owns it: that
-- would hand the organizer a second, read-only view of their own data and make
-- every "is this a linked user" test ambiguous.
create or replace function public.check_traveler_link()
returns trigger
language plpgsql
as $fn$
declare
  previously uuid;
begin
  -- OLD is unassigned on INSERT, so it is read once here rather than inline.
  if tg_op = 'UPDATE' then
    previously := old.linked_auth_user_id;
  end if;

  if new.linked_auth_user_id is not null and new.linked_auth_user_id = new.user_id then
    raise exception using errcode = 'check_violation',
      message = 'A profile cannot be linked to the account that owns it.';
  end if;

  -- Only the service role may GRANT a link, and it does so from the
  -- `invite-accept` path after checking a real invite. Without this, the
  -- organizer's own `travelers_update_own` policy would let them write any uuid
  -- they liked into this column by direct API call -- bypassing the tier gate,
  -- the minor guard and the invite itself. auth.uid() is null for the service
  -- role and non-null for any client, which is the whole distinction.
  --
  -- Clearing it is always allowed from a client: that is revocation, and
  -- revoking access must never be the operation that needs a server round trip.
  if new.linked_auth_user_id is not null
     and new.linked_auth_user_id is distinct from previously
     and auth.uid() is not null then
    raise exception using errcode = 'insufficient_privilege',
      message = 'A linked login is granted by accepting an invite, not by writing this field.';
  end if;

  return new;
end;
$fn$;

drop trigger if exists travelers_check_link on public.travelers;
create trigger travelers_check_link
  before insert or update on public.travelers
  for each row execute function public.check_traveler_link();

-- ---------------------------------------------------------------------------
-- RLS on the invites themselves
-- ---------------------------------------------------------------------------

alter table public.traveler_invites enable row level security;

-- The organizer manages invites for their own profiles. There is deliberately
-- no UPDATE policy: acceptance is written by the `invite-accept` Edge Function
-- with the service role, because the person accepting has no rights over the
-- organizer's rows at all. Revoking an unaccepted invite is a DELETE, which
-- leaves no half-state to reason about.
drop policy if exists traveler_invites_select_own on public.traveler_invites;
create policy traveler_invites_select_own on public.traveler_invites
  for select using (created_by = auth.uid());

drop policy if exists traveler_invites_insert_own on public.traveler_invites;
create policy traveler_invites_insert_own on public.traveler_invites
  for insert with check (created_by = auth.uid());

drop policy if exists traveler_invites_delete_own on public.traveler_invites;
create policy traveler_invites_delete_own on public.traveler_invites
  for delete using (created_by = auth.uid());

-- ---------------------------------------------------------------------------
-- What a linked member can read
-- ---------------------------------------------------------------------------
-- Every policy below is FOR SELECT. Read-only is therefore structural: there is
-- no write policy to weaken, and the feature plan's open question ("should they
-- tick off checklist items?") stays answered as no until someone deliberately
-- adds a policy, which is a visible act rather than a forgotten flag.

-- Their own profile row, and only their own. Not the other attendees': the
-- feature plan singles out `is_minor` as a sensitive signal that should not
-- reach a linked member beyond their own scope, and a co-attendee's profile is
-- outside that scope.
drop policy if exists travelers_select_linked on public.travelers;
create policy travelers_select_linked on public.travelers
  for select using (linked_auth_user_id = auth.uid());

drop policy if exists trips_select_linked on public.trips;
create policy trips_select_linked on public.trips
  for select using (id in (select public.linked_trip_ids(auth.uid())));

drop policy if exists trip_travelers_select_linked on public.trip_travelers;
create policy trip_travelers_select_linked on public.trip_travelers
  for select using (trip_id in (select public.linked_trip_ids(auth.uid())));

drop policy if exists trip_items_select_linked on public.trip_items;
create policy trip_items_select_linked on public.trip_items
  for select using (trip_id in (select public.linked_trip_ids(auth.uid())));

drop policy if exists trip_checklist_select_linked on public.trip_checklist_items;
create policy trip_checklist_select_linked on public.trip_checklist_items
  for select using (trip_id in (select public.linked_trip_ids(auth.uid())));

-- Their own documents -- genuinely their own data, which the feature plan says
-- explicitly. Never another traveler's, on any trip, for any reason.
drop policy if exists documents_select_linked on public.documents;
create policy documents_select_linked on public.documents
  for select using (traveler_id in (select public.linked_traveler_ids(auth.uid())));

-- Storage: object paths are <organizer auth id>/<traveler id>/<document id>.
-- The first segment is the ORGANIZER's id, so the existing owner-scoped policy
-- cannot match for a linked member. This one matches on the second segment
-- instead. Compared as text, never cast to uuid: a malformed path from any
-- source would otherwise raise an error inside a policy and fail the whole
-- query rather than simply not matching.
drop policy if exists documents_storage_select_linked on storage.objects;
create policy documents_storage_select_linked on storage.objects
  for select using (
    bucket_id = 'documents'
    and (storage.foldername(name))[2] in (
      select id::text from public.travelers where linked_auth_user_id = auth.uid()
    )
  );

-- ===========================================================================
-- MECHANISM 2 — one-off share link
-- ===========================================================================
--
-- For someone who is not a traveler profile and has no account. The token is
-- the entire access control, so it is treated as a credential: hashed at rest,
-- revocable, optionally auto-expiring, and never a route to documents unless
-- the organizer turned that on for this specific link.

create table if not exists public.share_links (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips (id) on delete cascade,
  created_by uuid not null references auth.users (id) on delete cascade,

  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),

  -- Free text for the organizer's own records ("Mum", "the house sitter"), so
  -- a list of live links is legible enough to revoke the right one.
  label text check (label is null or length(btrim(label)) <= 60),

  -- Off by default, per the feature plan. Turning it on is per-link and
  -- deliberate, never an account-wide setting.
  includes_documents boolean not null default false,

  revoked boolean not null default false,
  created_at timestamptz not null default now(),

  -- Null means no auto-expiry. The feature plan lists expiry as optional.
  expires_at timestamptz
);

create index if not exists share_links_trip_idx on public.share_links (trip_id);
create index if not exists share_links_creator_idx on public.share_links (created_by);

create or replace function public.check_share_link()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  owner_id uuid;
begin
  select t.user_id into owner_id from public.trips t where t.id = new.trip_id;

  if owner_id is null or owner_id <> new.created_by then
    raise exception using errcode = 'insufficient_privilege',
      message = 'You can only share your own trips.';
  end if;

  if not public.tier_has_feature(public.current_tier(new.created_by), 'trip_sharing') then
    raise exception using errcode = 'check_violation',
      message = 'Trip sharing is part of the Family plan.';
  end if;

  return new;
end;
$fn$;

drop trigger if exists share_links_check on public.share_links;
create trigger share_links_check
  before insert on public.share_links
  for each row execute function public.check_share_link();

alter table public.share_links enable row level security;

-- The owner manages their own links. `anon` gets NOTHING here -- a viewer holds
-- a token, not a session, and reads through the Edge Function only.
drop policy if exists share_links_select_own on public.share_links;
create policy share_links_select_own on public.share_links
  for select using (created_by = auth.uid());

drop policy if exists share_links_insert_own on public.share_links;
create policy share_links_insert_own on public.share_links
  for insert with check (created_by = auth.uid());

-- Revocation is an UPDATE, so unlike invites this table needs one. A WITH CHECK
-- cannot restrict which COLUMNS change, so the trigger below does that part.
drop policy if exists share_links_update_own on public.share_links;
create policy share_links_update_own on public.share_links
  for update using (created_by = auth.uid()) with check (created_by = auth.uid());

drop policy if exists share_links_delete_own on public.share_links;
create policy share_links_delete_own on public.share_links
  for delete using (created_by = auth.uid());

-- Only `revoked` and `expires_at` may change after creation. Letting the token
-- hash or `includes_documents` be edited in place would mean a link someone
-- already holds could silently gain access to documents, which is the opposite
-- of an explicit per-share decision. Un-revoking is refused too: a link
-- believed dead must stay dead.
create or replace function public.guard_share_link_update()
returns trigger
language plpgsql
as $fn$
begin
  if new.token_hash is distinct from old.token_hash
     or new.trip_id is distinct from old.trip_id
     or new.created_by is distinct from old.created_by
     or new.includes_documents is distinct from old.includes_documents
     or new.created_at is distinct from old.created_at then
    raise exception using errcode = 'check_violation',
      message = 'A share link cannot be edited. Revoke it and create a new one.';
  end if;

  if old.revoked and not new.revoked then
    raise exception using errcode = 'check_violation',
      message = 'A revoked share link cannot be reinstated.';
  end if;

  return new;
end;
$fn$;

drop trigger if exists share_links_guard_update on public.share_links;
create trigger share_links_guard_update
  before update on public.share_links
  for each row execute function public.guard_share_link_update();

-- ---------------------------------------------------------------------------
-- Rate limiting for the share link, per the feature plan's security note
-- ---------------------------------------------------------------------------
-- A 32-byte token is not guessable, but "not guessable" is an argument, and an
-- unauthenticated endpoint that will answer an unlimited number of questions is
-- still worth closing. Written and read only by the service role.
--
-- The caller's IP is stored as a SHA-256 hash. Rate limiting needs equality and
-- nothing else, so keeping the address itself would collect personal data this
-- feature has no use for.

create table if not exists public.share_link_attempts (
  id bigint generated always as identity primary key,
  client_hash text not null,
  succeeded boolean not null,
  at timestamptz not null default now()
);

create index if not exists share_link_attempts_recent_idx
  on public.share_link_attempts (client_hash, at desc);

alter table public.share_link_attempts enable row level security;
-- No policies at all: unreachable from any client, in either direction.

-- Housekeeping: the table only needs a short window to do its job.
create or replace function public.prune_share_link_attempts()
returns void
language sql
security definer
set search_path = public
as $fn$
  delete from public.share_link_attempts where at < now() - interval '1 day';
$fn$;
