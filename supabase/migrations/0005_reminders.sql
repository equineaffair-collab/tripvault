-- F2 — expiry reminders (Phase 3).
--
-- A daily sweep decides which documents are owed a reminder and writes a row
-- here. The row is the record that a milestone has been handled, which is what
-- stops the same notice going out twice.

create table if not exists public.reminders (
  id uuid primary key default gen_random_uuid(),

  -- Denormalised from the document's traveler so RLS and the sweep can both
  -- scope by user without a join through travelers on every read.
  user_id uuid not null references auth.users (id) on delete cascade,

  -- Generic by design: F8's payment-due reminders, if they land, reuse this
  -- table rather than getting one of their own.
  ref_type text not null default 'document' check (ref_type in ('document')),
  ref_id uuid not null,

  milestone integer not null check (milestone in (6, 3, 1)),

  remind_at date not null,
  channels text[] not null default '{}',

  sent boolean not null default false,
  sent_at timestamptz,

  -- True when the milestone's moment had already passed and a more urgent one
  -- was sent instead. Recorded so it never fires late; see planReminder.
  superseded boolean not null default false,

  -- F2's one-month banner must persist across app opens until acknowledged,
  -- not behave like a toast.
  acknowledged boolean not null default false,
  acknowledged_at timestamptz,

  created_at timestamptz not null default now()
);

-- A milestone is handled exactly once per document. This is the constraint that
-- makes the daily sweep safe to run repeatedly -- an accidental second run in
-- the same day cannot produce a second email.
create unique index if not exists reminders_once_per_milestone
  on public.reminders (ref_type, ref_id, milestone);

create index if not exists reminders_user_idx on public.reminders (user_id);
create index if not exists reminders_unsent_idx on public.reminders (sent) where not sent;
-- The banner query: unacknowledged one-month reminders for this user.
create index if not exists reminders_banner_idx
  on public.reminders (user_id) where milestone = 1 and not acknowledged;

alter table public.reminders enable row level security;

-- Read and acknowledge only. Reminders are created by the sweep running as the
-- service role -- a client that could insert them could also mark a milestone
-- handled without sending anything, which would silently defeat the feature.
drop policy if exists reminders_select_own on public.reminders;
create policy reminders_select_own on public.reminders
  for select using (user_id = auth.uid());

drop policy if exists reminders_acknowledge_own on public.reminders;
create policy reminders_acknowledge_own on public.reminders
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Notification preferences ---------------------------------------------------
--
-- There is deliberately NO email_enabled column.
--
-- F2 requires that email cannot be switched off: silencing every channel would
-- mean the app's core promise -- that you will not be caught out by an expired
-- document -- quietly stops holding, with no signal that it has. Leaving the
-- column out entirely enforces that structurally. A flag we agreed to ignore
-- would be one refactor away from being honoured.

create table if not exists public.notification_preferences (
  user_id uuid primary key references auth.users (id) on delete cascade,
  push_enabled boolean not null default true,
  expo_push_token text,
  updated_at timestamptz not null default now()
);

alter table public.notification_preferences enable row level security;

drop policy if exists notification_prefs_own on public.notification_preferences;
create policy notification_prefs_own on public.notification_preferences
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
