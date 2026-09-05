-- F4 — loyalty program storage (Phase 4).
--
-- Deliberately plain CRUD. F4 stores membership numbers for quick reference
-- when booking and explicitly does NOT sync point balances -- the test plan
-- checks that nothing was half-built in that direction.
--
-- Unlike documents (F1), the client writes here directly. No encryption key is
-- involved, so routing writes through an Edge Function would buy nothing. The
-- feature plan rates these as lower sensitivity than a passport number:
-- personal, but not a government-related identifier, so APP 9 does not bite.

create table if not exists public.loyalty_programs (
  id uuid primary key default gen_random_uuid(),

  traveler_id uuid not null references public.travelers (id) on delete cascade,

  type text not null
    check (type in ('airline', 'hotel', 'car_rental', 'rail', 'other')),

  provider_name text not null
    check (length(btrim(provider_name)) between 1 and 100),

  membership_number text not null
    check (length(btrim(membership_number)) between 1 and 100),

  tier_status text
    check (tier_status is null or length(btrim(tier_status)) <= 60),

  notes text check (notes is null or length(notes) <= 1000),

  created_at timestamptz not null default now()
);

create index if not exists loyalty_programs_traveler_id_idx
  on public.loyalty_programs (traveler_id);

-- F4 supports multiple programs per traveler, including several of the same
-- type (two airline schemes is normal). So there is deliberately NO unique
-- constraint on (traveler_id, type) -- the test plan checks a one-per-type
-- constraint has not crept in by accident.
--
-- The same provider twice is also legitimate (a personal and a business
-- membership), so the only thing rejected is an exact duplicate row.
create unique index if not exists loyalty_programs_no_exact_duplicates
  on public.loyalty_programs (traveler_id, provider_name, membership_number);

-- Row level security -------------------------------------------------------
--
-- Reachable only through a traveler the caller owns, the same shape as
-- documents. F9's note applies later: a linked family member or a shared trip
-- view must not surface another traveler's membership numbers, so when F9 adds
-- its policies it must not widen this one.

alter table public.loyalty_programs enable row level security;

drop policy if exists loyalty_select_own on public.loyalty_programs;
create policy loyalty_select_own on public.loyalty_programs
  for select using (
    exists (
      select 1 from public.travelers t
       where t.id = loyalty_programs.traveler_id and t.user_id = auth.uid()
    )
  );

drop policy if exists loyalty_insert_own on public.loyalty_programs;
create policy loyalty_insert_own on public.loyalty_programs
  for insert with check (
    exists (
      select 1 from public.travelers t
       where t.id = loyalty_programs.traveler_id and t.user_id = auth.uid()
    )
  );

drop policy if exists loyalty_update_own on public.loyalty_programs;
create policy loyalty_update_own on public.loyalty_programs
  for update using (
    exists (
      select 1 from public.travelers t
       where t.id = loyalty_programs.traveler_id and t.user_id = auth.uid()
    )
  ) with check (
    exists (
      select 1 from public.travelers t
       where t.id = loyalty_programs.traveler_id and t.user_id = auth.uid()
    )
  );

drop policy if exists loyalty_delete_own on public.loyalty_programs;
create policy loyalty_delete_own on public.loyalty_programs
  for delete using (
    exists (
      select 1 from public.travelers t
       where t.id = loyalty_programs.traveler_id and t.user_id = auth.uid()
    )
  );
