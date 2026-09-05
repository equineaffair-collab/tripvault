-- F3 — trip folder, attendees, bookings and checklist (Phase 5).
--
-- Four tables. `trips` and `trip_checklist_items` belong to the account;
-- `trip_travelers` joins a trip to the account's own traveler profiles; and
-- `trip_items` holds bookings, with a nullable trip_id because F5 needs a
-- "Needs a trip" holding area for a forwarded email that cannot yet be matched
-- to one. That nullable column is F5's requirement landing in F3's table, so it
-- exists now rather than being retrofitted onto a table holding real data.

create table if not exists public.trips (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 120),
  destination text check (destination is null or length(btrim(destination)) <= 120),
  start_date date,
  end_date date,
  -- F6 will recommend which passport to travel on; null until then.
  traveling_on_document_id uuid references public.documents (id) on delete set null,
  created_at timestamptz not null default now(),

  constraint trips_dates_ordered
    check (start_date is null or end_date is null or start_date <= end_date)
);

create index if not exists trips_user_id_idx on public.trips (user_id);
create index if not exists trips_start_date_idx on public.trips (start_date);

-- Attendees ----------------------------------------------------------------
-- F3 selects from the account's OWN traveler profiles. This is not sharing:
-- showing a trip to someone outside the account is F9, an entirely separate
-- mechanism with its own access path.

create table if not exists public.trip_travelers (
  trip_id uuid not null references public.trips (id) on delete cascade,
  traveler_id uuid not null references public.travelers (id) on delete cascade,
  primary key (trip_id, traveler_id)
);

create index if not exists trip_travelers_traveler_idx
  on public.trip_travelers (traveler_id);

-- Bookings -----------------------------------------------------------------

create table if not exists public.trip_items (
  id uuid primary key default gen_random_uuid(),
  -- Nullable ON PURPOSE: F5's "Needs a trip" holding area. An item with a null
  -- trip_id still belongs to a user, hence user_id below -- without it a
  -- forwarded booking would have no owner and no way to be scoped by RLS.
  trip_id uuid references public.trips (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,

  type text not null
    check (type in ('flight', 'accommodation', 'car_hire', 'transfer', 'activity', 'other')),

  provider text check (provider is null or length(btrim(provider)) <= 120),
  confirmation_number text check (confirmation_number is null or length(btrim(confirmation_number)) <= 120),

  -- How it arrived, so F5's extraction can be told from manual entry.
  source text not null default 'manual'
    check (source in ('manual', 'photo', 'email', 'link')),

  file_path text,
  external_link text,
  item_date timestamptz,
  amount_due numeric(12, 2),
  due_date date,
  notes text check (notes is null or length(notes) <= 2000),
  created_at timestamptz not null default now()
);

create index if not exists trip_items_trip_idx on public.trip_items (trip_id);
create index if not exists trip_items_user_idx on public.trip_items (user_id);
-- The holding area is a query the app runs often; index the null case directly.
create index if not exists trip_items_unassigned_idx
  on public.trip_items (user_id) where trip_id is null;

-- Checklist ----------------------------------------------------------------
--
-- F3 wants a flat, groupable checklist rather than a dropdown, with
-- auto-generated deadline-driven items visually pinned above routine planning
-- tasks. `source` is what makes that distinction possible, and `linked_trip_item_id`
-- is what stops the checklist becoming a second, disconnected source of truth
-- alongside the real bookings.

create table if not exists public.trip_checklist_items (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips (id) on delete cascade,

  label text not null check (length(btrim(label)) between 1 and 200),

  category text not null default 'planning'
    check (category in ('documents', 'bookings', 'money_insurance', 'planning')),

  status text not null default 'todo' check (status in ('todo', 'done')),

  source text not null default 'manual'
    check (source in ('manual', 'auto-passport', 'auto-entry-requirement', 'default')),

  linked_trip_item_id uuid references public.trip_items (id) on delete set null,

  created_at timestamptz not null default now()
);

create index if not exists trip_checklist_trip_idx
  on public.trip_checklist_items (trip_id);

-- An auto-generated item must not be created twice for the same trip and
-- reason -- re-running the passport check on save should update, not duplicate.
create unique index if not exists trip_checklist_auto_unique
  on public.trip_checklist_items (trip_id, source, label)
  where source <> 'manual';

-- Row level security -------------------------------------------------------

alter table public.trips enable row level security;
alter table public.trip_travelers enable row level security;
alter table public.trip_items enable row level security;
alter table public.trip_checklist_items enable row level security;

drop policy if exists trips_own on public.trips;
create policy trips_own on public.trips
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Attendee rows are reachable through a trip the caller owns. The traveler must
-- ALSO belong to the caller, so a trip cannot be populated with someone else's
-- traveler profile by guessing an id.
drop policy if exists trip_travelers_own on public.trip_travelers;
create policy trip_travelers_own on public.trip_travelers
  for all using (
    exists (select 1 from public.trips t where t.id = trip_travelers.trip_id and t.user_id = auth.uid())
  ) with check (
    exists (select 1 from public.trips t where t.id = trip_travelers.trip_id and t.user_id = auth.uid())
    and exists (select 1 from public.travelers tr where tr.id = trip_travelers.traveler_id and tr.user_id = auth.uid())
  );

drop policy if exists trip_items_own on public.trip_items;
create policy trip_items_own on public.trip_items
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists trip_checklist_own on public.trip_checklist_items;
create policy trip_checklist_own on public.trip_checklist_items
  for all using (
    exists (select 1 from public.trips t where t.id = trip_checklist_items.trip_id and t.user_id = auth.uid())
  ) with check (
    exists (select 1 from public.trips t where t.id = trip_checklist_items.trip_id and t.user_id = auth.uid())
  );
