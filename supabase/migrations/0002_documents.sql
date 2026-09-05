-- F1 — document vault.
--
-- The security shape here follows the encryption decision recorded in
-- supabase/functions/documents: the key lives in an Edge Function secret, so a
-- compromise of this database alone yields ciphertext and no means to read it.
--
-- That only holds if the database cannot be talked into storing plaintext, so
-- writes are deliberately closed to the client: there is no INSERT or UPDATE
-- policy for authenticated users on `documents`. Only the service role -- which
-- bypasses RLS, and which only the Edge Function holds -- can write a document.
-- The client may read (it gets ciphertext, which is useless on its own) and
-- delete (which needs no key).

create extension if not exists "pgcrypto";

-- 0. F1's parent/guardian acknowledgment ------------------------------------
--
-- F11 owns the is_minor flag; F1 owns this. Recorded once per profile, at the
-- point a minor's document is first entered rather than buried in signup, and
-- written by the Edge Function at the moment it is relied upon -- so the record
-- is evidence the gate actually ran, not just that a checkbox existed.

alter table public.travelers
  add column if not exists guardian_acknowledged_at timestamptz;

comment on column public.travelers.guardian_acknowledged_at is
  'F1: when the account holder confirmed they are this minor''s parent or legal '
  'guardian. Null means no document may be entered for a minor profile.';

-- 1. Table ------------------------------------------------------------------

create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),

  traveler_id uuid not null references public.travelers (id) on delete cascade,

  type text not null check (type in ('passport', 'visa', 'id_card', 'other')),

  -- ICAO 3-letter issuing state, e.g. AUS. Not a foreign key: this is reference
  -- data from the MRZ, and an unrecognised code should not block saving.
  country text check (country is null or country ~ '^[A-Z]{3}$'),

  -- Named for what it holds so plaintext cannot be written here by accident,
  -- and constrained to the envelope shape so it cannot be written on purpose
  -- either. Format: v<n>.<base64 iv>.<base64 ciphertext+tag>.
  --
  -- APP 9: this is an attribute, never an identifier. Nothing references a
  -- document by its number -- `id` above is the only key.
  document_number_encrypted text not null
    check (document_number_encrypted ~ '^v[0-9]+\.[A-Za-z0-9+/]+=*\.[A-Za-z0-9+/]+=*$'),

  issue_date date,
  expiry_date date,

  is_primary boolean not null default false,

  -- Object path inside the private `documents` storage bucket, NOT a URL.
  -- Storing a URL would imply a durable link; access is by short-lived signed
  -- URL generated per request instead.
  file_path text,

  created_at timestamptz not null default now(),

  constraint documents_dates_ordered
    check (issue_date is null or expiry_date is null or issue_date <= expiry_date)
);

create index if not exists documents_traveler_id_idx on public.documents (traveler_id);
create index if not exists documents_expiry_date_idx on public.documents (expiry_date);

-- F1: multiple passports per traveler (dual nationality), one marked primary.
create unique index if not exists documents_one_primary_per_type
  on public.documents (traveler_id, type)
  where is_primary;

-- 2. Row level security -----------------------------------------------------

alter table public.documents enable row level security;

-- Read: a document is reachable only through a traveler the caller owns.
drop policy if exists documents_select_own on public.documents;
create policy documents_select_own on public.documents
  for select using (
    exists (
      select 1 from public.travelers t
       where t.id = documents.traveler_id
         and t.user_id = auth.uid()
    )
  );

-- Delete: allowed directly, since removing a row needs no encryption key.
drop policy if exists documents_delete_own on public.documents;
create policy documents_delete_own on public.documents
  for delete using (
    exists (
      select 1 from public.travelers t
       where t.id = documents.traveler_id
         and t.user_id = auth.uid()
    )
  );

-- No INSERT or UPDATE policy, deliberately. Both go through the Edge Function
-- so the number is encrypted before it reaches Postgres. Adding a policy here
-- would let the client write whatever it liked into the encrypted column.

-- 3. Access log -------------------------------------------------------------
--
-- The security review asks for a record of who read or changed a document and
-- when. Every decrypt is an Edge Function call, so the log is written there.

create table if not exists public.document_access_log (
  id uuid primary key default gen_random_uuid(),
  document_id uuid references public.documents (id) on delete set null,
  actor_user_id uuid references auth.users (id) on delete set null,
  action text not null check (action in ('create', 'update', 'decrypt', 'delete')),
  succeeded boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists document_access_log_document_idx
  on public.document_access_log (document_id, created_at desc);
create index if not exists document_access_log_actor_idx
  on public.document_access_log (actor_user_id, created_at desc);

-- document_id is nullable and ON DELETE SET NULL on purpose: deleting a
-- document must not erase the record that it once existed and was accessed.

alter table public.document_access_log enable row level security;

-- A user can read their own access history, for transparency. Nobody can write
-- or alter it from the client -- only the service role appends, and there is no
-- update or delete policy at all, so the log is append-only from outside.
drop policy if exists document_access_log_select_own on public.document_access_log;
create policy document_access_log_select_own on public.document_access_log
  for select using (actor_user_id = auth.uid());

-- 4. Storage ----------------------------------------------------------------
--
-- The scan itself is more sensitive than the number: the image contains the
-- number, the photo and the MRZ together. The bucket is private, so objects are
-- reachable only by a short-lived signed URL, never a public path.
--
-- Object naming convention, enforced by the policies below:
--   <auth user id>/<traveler id>/<document id>.<ext>

insert into storage.buckets (id, name, public)
values ('documents', 'documents', false)
on conflict (id) do update set public = false;

drop policy if exists documents_storage_select_own on storage.objects;
create policy documents_storage_select_own on storage.objects
  for select using (
    bucket_id = 'documents'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists documents_storage_insert_own on storage.objects;
create policy documents_storage_insert_own on storage.objects
  for insert with check (
    bucket_id = 'documents'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists documents_storage_update_own on storage.objects;
create policy documents_storage_update_own on storage.objects
  for update using (
    bucket_id = 'documents'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists documents_storage_delete_own on storage.objects;
create policy documents_storage_delete_own on storage.objects
  for delete using (
    bucket_id = 'documents'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Note for the security review: the object is protected by bucket privacy and
-- these policies, but its bytes are not themselves encrypted with our key the
-- way the document number is. Encrypting the image before upload is the next
-- step up and is tracked as an open item, not done here.
