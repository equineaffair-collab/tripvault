# TripVault — development plan (v2)

Derived from `tripvault-feature-plan.md` as of this date. This is a snapshot, not a second source of truth — if the feature plan changes further, regenerate the relevant sections here rather than hand-editing both documents independently. Supersedes the earlier `trip-vault-app-development-plan.md`.

## 1. Architecture at a glance

| Layer | Choice | Used by |
|---|---|---|
| App framework | React Native + Expo (managed, dev build required — not Expo Go) | All features |
| Backend | Supabase (Postgres, Auth, Storage, Edge Functions, pg_cron) | All features |
| Document (MRZ) extraction | On-device OCR — `@react-native-ml-kit/text-recognition` + `mrz` for parsing and check-digit validation. No network, no per-scan cost, image never leaves the device | F1 |
| Booking extraction | Claude API (vision + text) — unstructured confirmation formats, where a model genuinely earns its place | F5 |
| Document scanning UX | `react-native-document-scanner-plugin` (wraps Apple VisionKit / Google ML Kit) | F1 |
| Transactional + inbound email | Postmark or Mailgun, one vendor covering both jobs | F2, F5 |
| Push notifications | Expo push notifications | F2 |
| Subscriptions | RevenueCat (wraps App Store/Play) | F8 |
| Physical-goods checkout | Stripe — separate from RevenueCat, since physical goods can't go through platform IAP | F10 |
| Print fulfillment | Peecho (Prodigi Group) — Print API + Book Creator API | F10 |
| Visa data (future) | Commercial API (RapidAPI Travel Buddy or Zylalabs — not yet chosen) | F7 |

## 2. Data model, consolidated

```
travelers (F11)
  id, user_id, name, relationship (self/partner/child/other), is_minor, created_at

documents (F1)
  id, traveler_id, type, country, document_number (encrypted — never used as
  a key or identifier, see §4), issue_date, expiry_date, is_primary, file_url,
  created_at

trips (F3)
  id, user_id, name, destination, start_date, end_date,
  traveling_on_document_id (nullable, references documents.id)

trip_travelers (F3)
  trip_id, traveler_id

trip_items (F3, F5)
  id, trip_id (nullable — see F5's "Needs a trip" holding state), type,
  provider, confirmation_number, source, file_url, external_link,
  item_date, amount_due, due_date, notes

trip_checklist_items (F3)
  id, trip_id, label, category, status, source, linked_trip_item_id (nullable)

loyalty_programs (F4)
  id, traveler_id, type, provider_name, membership_number, tier_status, notes

reminders (F2)
  id, ref_type, ref_id, remind_at, channel, sent

entry_requirements (F6)
  country, min_passport_validity_months, verified, last_verified, notes
  — validity only, deliberately no visa field (see F7's split)

share_links (F9, secondary mechanism)
  id, trip_id, token, created_at, expires_at, revoked, includes_documents

travelers.linked_auth_user_id (F9, primary mechanism)
  nullable — set once a family member accepts their own-login invite

photos (F10, future)
  id, trip_id, trip_item_id (nullable), file_url, taken_at, caption
```

Full behavior for every table above lives in `tripvault-feature-plan.md` under its F-number — this is a reference index, not a restatement.

## 3. Build roadmap

Ordered by dependency (nothing is scheduled before what it needs) and priority (core before nice-to-have, nice-to-have before future). Each phase = one Claude Code session; see `tripvault-claude-code-prompts.md` for the actual prompts.

| Phase | Feature(s) | Why here |
|---|---|---|
| 0 | Setup | Repo, Supabase project, auth, navigation shell |
| 1 | F11 | Foundational — everything else attaches to a traveler |
| 2 | F1 | Depends only on F11; the free-tier hook feature |
| 3 | F2 | Depends on F1 |
| 4 | F4 | Depends only on F11; simple, slots in early |
| 5 | F3 | Depends on F1 + F11; the biggest core feature, includes the F6 stub integration point |
| 6 | F8 | Gating needs F1/F3/F11 to exist first |
| 7 | F12 | Data export/deletion needs the full core data model (F1, F3, F4, F11) to be meaningful |
| 8 | F6 | Nice-to-have, paid — soft-integrates into F3's existing stub |
| 9 | F5 | Nice-to-have, paid — needs email infrastructure |
| 10 | F9 | Nice-to-have/future — the linked-login mechanism is real auth complexity |
| 11 | F7 | Future — don't build until asked, per the feature plan |
| 12 | F10 | Future — don't build until asked, per the feature plan |

## 4. Security, consolidated

Full detail lives in the feature plan's "Security & compliance review" section. The two points worth carrying into every relevant phase without fail:

- **Never use a passport number (or any government-related identifier) as an internal database key or identifier for a person** — always a generated UUID, with the document number stored purely as an attribute. This is an Australian Privacy Principle 9 requirement, not just good practice, and it's easiest to get right in F1's initial schema and hardest to retrofit later.
- **F12 (data export/deletion) needs a real, tested cascade-delete path** across every table in §2 — build this with the same care as the feature that creates the data, not as an afterthought once everything else works.

Other items from the review (encryption in transit, MFA, breach response plan, vendor data processing agreements, audit logging, PCI scope) are process and infrastructure decisions more than single-phase build tasks — track them against `tripvault-setup-steps.md` rather than a specific phase.

## 5. What's deliberately not in this roadmap yet

F7 (visa checker) and F10 (photo books) are fully specified in the feature plan but intentionally not built until asked — both carry real ongoing costs (a per-lookup API fee and photo storage respectively) that are cheaper to commit to once there's a real user base than up front.
