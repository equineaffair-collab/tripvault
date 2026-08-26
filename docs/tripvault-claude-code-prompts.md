# Claude Code build kit — TripVault (v2)

Supersedes the earlier `trip-vault-claude-code-prompts.md`. The big change: rather than re-explaining every feature's behavior inline, these prompts point Claude Code at `tripvault-feature-plan.md` for the actual spec, and only add what the feature plan doesn't already cover — sequencing, and how phases hand off to each other. Keep both files in the project's docs folder; a prompt that says "implement F1" is only useful if Claude Code can read what F1 means.

Save the CLAUDE.md block below in your repo root before your first session.

---

## CLAUDE.md (save this in your repo root)

```markdown
# TripVault — project context

## What this is
A mobile app storing a traveler's documents (passport, visa, ID) and every
booking for a trip in one place, with reminders for document expiry and
payment due dates, built for people who organize travel for family members
as well as themselves.

## Source of truth
Full feature specifications — what each feature does, how it works, its
dependencies, security notes, and technical stack notes — live in
`tripvault-feature-plan.md`, indexed by F-number (F1, F2, ...). Read the
relevant F-number(s) before starting any phase below. This file (CLAUDE.md)
covers only project-wide conventions and the consolidated schema; it does
not restate feature behavior — if something seems ambiguous, the feature
plan is the tie-breaker, not this file.

## Stack
React Native + Expo (dev build required, not Expo Go) · Supabase (Postgres,
Auth, Storage, Edge Functions, pg_cron) · Claude API (vision) for document
and booking extraction · react-native-document-scanner-plugin for capture ·
Postmark or Mailgun for email (both transactional and inbound parsing) ·
Expo push notifications · RevenueCat for subscriptions · Stripe (separate
from RevenueCat) for physical goods · Peecho for print fulfillment (future).

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

## Schema
travelers (F11): id, user_id, name, relationship, is_minor,
  linked_auth_user_id (nullable, F9), created_at
documents (F1): id, traveler_id, type, country, document_number (encrypted),
  issue_date, expiry_date, is_primary, file_url, created_at
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
- Write a short test for every Edge Function that touches money, reminder
  scheduling, or account deletion.
- Ask before adding a new third-party dependency.
```

---

## Phase 0 — project setup

```
Set up a new Expo (managed, TypeScript) React Native project called
TripVault, with a dev build (this app needs native modules, Expo Go won't
work). Initialize git, connect it to [paste your empty GitHub repo URL
here] as the remote, and push the initial commit. Connect a Supabase
project via environment variables (.env, gitignored — make sure this
actually ends up in .gitignore before the first commit, not after). Set up
email/password auth and a bottom-tab navigation shell (Documents, Trips,
Profile) — no feature screens yet, just confirm sign-up, log-in, and three
empty tabs work end to end.
```

## Phase 1 — F11: traveler profile management

```
Read F11 in tripvault-feature-plan.md and implement it as specified —
profile creation with name and relationship field, the is_minor flag, and
the linked_auth_user_id column ready for F9 later (leave it null and unused
for now). Set up Supabase RLS so a user can only read/write their own
traveler profiles. Walk me through testing: create two profiles, one marked
as a child.
```

## Phase 2 — F1: document vault

```
Read F1 in tripvault-feature-plan.md and implement it as specified —
document-scanner-plugin capture, MRZ extraction with checksum validation
via the Claude API, the confirm-or-correct flow, multiple passports per
traveler, and the parent/guardian acknowledgment gate for minor profiles
(check the is_minor flag from F11's traveler record). Encrypt
document_number before writing it, and don't use it as an identifier
anywhere in the schema — see CLAUDE.md's critical constraints. Test with
both an adult and a minor profile from Phase 1.
```

## Phase 3 — F2: expiry reminders

```
Read F2 in tripvault-feature-plan.md and implement the escalating
email/push reminder logic exactly as specified — email-only at 6 months,
email+push at 3 months, email+push+in-app banner at 1 month, with email
non-optional. Set up the daily Supabase Edge Function + pg_cron job and the
Postmark/Mailgun outbound integration.
```

## Phase 4 — F4: loyalty program storage

```
Read F4 in tripvault-feature-plan.md and implement it — straightforward
CRUD, multiple programs per traveler, no balance syncing.
```

## Phase 5 — F3: trip folder and checklist

```
Read F3 in tripvault-feature-plan.md and implement it in full — attendee
selection from F11's traveler profiles, the automatic passport-validity
check on save (reusing F1's data), the checklist with its grouping and
urgency-pinning design, and the "Check entry requirements" button. Build
that button as a real soft integration point per CLAUDE.md's critical
constraints: check whether F6's functionality exists before calling it, and
show the "not available yet" fallback if it doesn't — F6 isn't built until
Phase 8, so this fallback path is what should actually run for now, and
it's worth testing that it does.
```

## Phase 6 — F8: subscription tiers

```
Read F8 in tripvault-feature-plan.md and implement the four-tier structure
exactly as specified, including which features are excluded from the tier
table entirely (F7, F10 — don't gate those here). Integrate RevenueCat;
I'll provide the product IDs once they're set up in App Store Connect /
Play Console. Gate multi-traveler profiles (F11) and multi-trip (F3)
according to the table.
```

## Phase 7 — F12: data export and account deletion

```
Read F12 in tripvault-feature-plan.md and implement it — the export package
covering F1, F3, F4, F11 data, and a genuine cascading hard delete across
every table listed in CLAUDE.md's schema. Require re-authentication
immediately before generating an export. Write a test that checks no
orphaned records remain in any table after a full account deletion —
this is explicitly called out as needing verification, not just an
implementation.
```

## Phase 8 — F6: passport validity checker

```
Read F6 in tripvault-feature-plan.md and implement it — the
entry_requirements table (seeded from tripvault-entry-requirements-starter.md,
carrying the verified/last_verified flags through as-is), the multi-passport
comparison logic, and the recommendation of which passport to travel on.
Wire it into F3's existing "Check entry requirements" button from Phase 5 —
this should now run the real check instead of showing the fallback message.
Gate this behind Pro/Family/Lifetime per F8.
```

## Phase 9 — F5: email and photo auto-extraction

```
Read F5 in tripvault-feature-plan.md and implement both paths as
specified — the in-app photo/PDF path (reuses F1's extraction pattern
pointed at booking fields), and the email-forwarding path (per-user
forwarding address, Postmark/Mailgun inbound webhook, the "Needs a trip"
holding state for trip_items.trip_id when no trip can be matched). Gate
behind Pro/Family/Lifetime per F8.
```

## Phase 10 — F9: family member access

```
Read F9 in tripvault-feature-plan.md and implement the primary mechanism —
a traveler profile (F11) can be invited to its own linked login via
travelers.linked_auth_user_id, scoped read-only access to trips where their
traveler_id appears in trip_travelers, and document downloads for offline
access. Also implement the secondary one-off link mechanism (share_links
table) for a true outsider who isn't a traveler profile at all. Keep the
two mechanisms clearly separate in the code, not a shared code path with
branching — they have different security models.
```

## Phase 11 — F7: visa requirement checker (future, don't build yet)

```
Don't build this until I ask. When I do, read F7 in
tripvault-feature-plan.md — it depends on choosing a commercial visa API
(RapidAPI Travel Buddy or Zylalabs, not yet decided) and needs its own
metered pricing, not a slot in the F8 tier table.
```

## Phase 12 — F10: trip photo books (future, don't build yet)

```
Don't build this until I ask. When I do, read F10 in
tripvault-feature-plan.md — Peecho integration, the staged photo retention
policy, and the separate Stripe checkout are all specified there in detail.
```

---

## General tips

- Start each phase by pointing Claude Code at the relevant F-number and letting it ask clarifying questions before writing code — don't pre-answer things it hasn't asked.
- Commit after every phase; consider a branch per phase for clean rollback.
- If the feature plan changes after a phase is already built, re-read the updated F-number before making the change rather than relying on memory of what it used to say — this file only reflects the feature plan as of when this build kit was generated.
