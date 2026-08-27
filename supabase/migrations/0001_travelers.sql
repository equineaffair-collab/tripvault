-- F11 — traveler profile management
-- The foundational table: F1's documents, F3's trip_travelers and F4's
-- loyalty_programs all key off travelers.id.

create table if not exists public.travelers (
  id uuid primary key default gen_random_uuid(),

  -- The account that owns this profile. Always a generated UUID identifying
  -- the person, never a government identifier (APP 9 — see CLAUDE.md).
  user_id uuid not null references auth.users (id) on delete cascade,

  name text not null check (length(btrim(name)) between 1 and 100),

  relationship text not null
    check (relationship in ('self', 'partner', 'child', 'other')),

  -- Derived from relationship by the trigger below, never set by the client.
  is_minor boolean not null default false,

  -- F9 (Phase 10). Null and unused until a family member accepts their own
  -- login invite; declared now so F9 does not require a table rewrite.
  linked_auth_user_id uuid references auth.users (id) on delete set null,

  created_at timestamptz not null default now()
);

create index if not exists travelers_user_id_idx on public.travelers (user_id);

-- One profile may be linked to at most one auth user (F9).
create unique index if not exists travelers_linked_auth_user_id_key
  on public.travelers (linked_auth_user_id)
  where linked_auth_user_id is not null;

-- ---------------------------------------------------------------------------
-- is_minor is set server-side, deliberately.
--
-- F1 gates its parent/guardian acknowledgment on this flag. If the client set
-- it, a direct API call could create a "child" profile with is_minor = false
-- and walk straight past that gate. Deriving it in a trigger means the flag
-- follows from relationship no matter what route the write arrives by.
-- ---------------------------------------------------------------------------
create or replace function public.set_traveler_is_minor()
returns trigger
language plpgsql
as $$
begin
  new.is_minor := (new.relationship = 'child');
  return new;
end;
$$;

drop trigger if exists travelers_set_is_minor on public.travelers;
create trigger travelers_set_is_minor
  before insert or update of relationship on public.travelers
  for each row execute function public.set_traveler_is_minor();

-- ---------------------------------------------------------------------------
-- RLS: an account reaches only its own traveler profiles.
--
-- Phase 10 (F9) adds a second, read-only policy for a linked family member.
-- It is deliberately not present yet — linked_auth_user_id grants nothing.
-- ---------------------------------------------------------------------------
alter table public.travelers enable row level security;

drop policy if exists travelers_select_own on public.travelers;
create policy travelers_select_own on public.travelers
  for select using (auth.uid() = user_id);

drop policy if exists travelers_insert_own on public.travelers;
create policy travelers_insert_own on public.travelers
  for insert with check (auth.uid() = user_id);

drop policy if exists travelers_update_own on public.travelers;
create policy travelers_update_own on public.travelers
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists travelers_delete_own on public.travelers;
create policy travelers_delete_own on public.travelers
  for delete using (auth.uid() = user_id);
