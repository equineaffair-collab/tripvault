# TripVault — project context

## What this is
A mobile app storing a traveler's documents (passport, visa, ID) and every
booking for a trip in one place, with reminders for document expiry and
payment due dates, built for people who organize travel for family members
as well as themselves.

## Source of truth
Full feature specifications — what each feature does, how it works, its
dependencies, security notes, and technical stack notes — live in
`docs/tripvault-feature-plan.md`, indexed by F-number (F1, F2, ...). Read the
relevant F-number(s) before starting any phase below. This file (CLAUDE.md)
covers only project-wide conventions and the consolidated schema; it does
not restate feature behavior — if something seems ambiguous, the feature
plan is the tie-breaker, not this file.

Build phases and their prompts: `docs/tripvault-claude-code-prompts.md`.
Test plan: `docs/tripvault-test-plan.md`.
Manual/account setup you must do yourself: `docs/tripvault-setup-steps.md`.

## Stack
React Native + Expo (dev build required, not Expo Go) · Supabase (Postgres,
Auth, Storage, Edge Functions, pg_cron) · on-device OCR (@react-native-ml-kit/
text-recognition + the `mrz` package) for F1's MRZ extraction · Claude API for
F5's booking extraction only · react-native-document-scanner-plugin for capture ·
Postmark or Mailgun for email (both transactional and inbound parsing) ·
Expo push notifications · RevenueCat for subscriptions · Stripe (separate
from RevenueCat) for physical goods · Peecho for print fulfillment (future).

Expo SDK 57 / React Native 0.86 / React 19 — newer than most training data.
Check the versioned docs at https://docs.expo.dev/versions/v57.0.0/ before
assuming an API shape, and use `npx expo install` (not `npm install`) for any
package with a native side, so the SDK-compatible version is chosen.

## Critical constraints
- Never use a passport number or any other government-related identifier as
  a database key or as the identifier for a person — always a generated
  UUID, with the identifier stored purely as an encrypted attribute. This is
  an Australian Privacy Principle 9 requirement, not a style preference.
- Never attempt a "connect your Booking.com/Airbnb account" OAuth flow —
  neither platform offers a public API for reading a user's own bookings.
  The only booking input methods are manual entry, pasting a link,
  uploading a photo/PDF, or forwarding a confirmation email (F5).
- Physical goods (F10, future) must never go through RevenueCat or platform
  IAP — Apple and Google don't permit IAP for physical goods. That flow
  needs its own separate Stripe integration.
- F6 and F7 are deliberately separate concerns (passport validity vs. visa
  requirement) — don't merge them back together even though they look
  related. See F6's design note in the feature plan for why they were split.
- F3's "Check entry requirements" button is a soft integration point with
  F6, not a hard dependency — it must degrade to a plain "not available
  yet" message if F6 isn't built, never error or disappear.
- Never send a passport or ID image off the device. F1's MRZ extraction is
  on-device by design (see F1's design note in the feature plan) — do not
  reintroduce a hosted vision call for it. The Claude API is for F5's booking
  extraction only, where the input is unstructured booking text.

## Schema
travelers (F11): id, user_id, name, relationship, is_minor,
  linked_auth_user_id (nullable, F9), created_at
documents (F1): id, traveler_id, type, country, document_number_encrypted,
  issue_date, expiry_date, is_primary, file_path, created_at
  - document_number_encrypted, not document_number: named for what it holds so
    plaintext cannot land there by accident, and CHECK-constrained to the
    envelope shape so it cannot land there on purpose either.
  - file_path, not file_url: an object path in the private `documents` bucket.
    Storing a URL would imply a durable link; access is by short-lived signed
    URL generated per request.
travelers.guardian_acknowledged_at (F1): nullable timestamptz, set by the Edge
  Function when a minor profile's parent/guardian gate is confirmed
document_access_log (F1): id, document_id, actor_user_id, action, succeeded,
  created_at -- append-only from outside; the owner may read their own rows
trips (F3): id, user_id, name, destination, start_date, end_date,
  traveling_on_document_id (nullable)
trip_travelers (F3): trip_id, traveler_id
trip_items (F3, F5): id, trip_id (nullable), type, provider,
  confirmation_number, source, file_url, external_link, item_date,
  amount_due, due_date, notes
trip_checklist_items (F3): id, trip_id, label, category, status, source,
  linked_trip_item_id (nullable)
loyalty_programs (F4): id, traveler_id, type, provider_name,
  membership_number, tier_status, notes
reminders (F2): id, ref_type, ref_id, remind_at, channel, sent
entry_requirements (F6): country, min_passport_validity_months, verified,
  last_verified, notes
share_links (F9, secondary mechanism): id, trip_id, token, created_at,
  expires_at, revoked, includes_documents
photos (F10, future): id, trip_id, trip_item_id (nullable), file_url,
  taken_at, caption

## Conventions
- TypeScript everywhere, strict mode on.
- Keep extraction prompts (document and booking parsing) in `/lib/prompts/`
  as their own files, not inline in components.
- Encrypt sensitive fields before writing to Supabase, never in plaintext.
  For F1's document_number this is concrete: the key lives ONLY in the
  `documents` Edge Function's DOCUMENT_ENCRYPTION_KEY secret. Never put it in
  the app bundle, in .env, or in the database -- key/data separation is the
  whole reason a database compromise yields ciphertext, and is what GDPR Art
  34(3)(a) and Australia's NDB scheme actually turn on. `documents` has no
  INSERT or UPDATE policy for authenticated users by design: writes go through
  the Edge Function. Do not add one.
- Write a short test for every Edge Function that touches money, reminder
  scheduling, or account deletion.
- Ask before adding a new third-party dependency.
