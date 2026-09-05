# TripVault — project history

Why things are the way they are, and what state they are actually in. `git log`
covers what changed; this covers what it cost to decide and what is still
unproven. Read the Current state section first.

---

## Current state

*As of 2026-09-05.*

**Built and verified against the live Supabase project:**
- **Phase 0** — Expo SDK 57 / RN 0.86 / TypeScript strict. Email+password auth,
  three-tab shell.
- **Phase 1 (F11)** — traveler profiles. 19/19 live checks pass.
- **Phase 2 (F1)** — document vault storage, encryption, Edge Function, guardian
  gate, audit log. 23/23 live checks pass.

**Verified running on a device (Android emulator):** sign-up, log-in, traveler
profiles including the minor badge, the traveler picker, empty states, and
session persistence across a full app restart — which is the real proof the
chunked SecureStore adapter works.

**Still unverified, and the main open risk:** the scan path end to end. The
scanner launches, but no passport has been read. `lib/scan.ts` handles three
possible ML Kit result shapes and has never seen real output. This needs a
physical phone; an emulator webcam is not a fair test.

**Dev build:** Android development APK built 2026-09-05, in `build-artifacts/`
(gitignored). EAS project `@blackbirdzz-property/tripvault`. Rebuild only when
native dependencies change; JS reloads over Metro.

**Local tooling** (no admin required, all under `%LOCALAPPDATA%`): Temurin JDK 21
in `AndroidTooling\jdk`, Android SDK in `Android\Sdk` with platform-tools,
emulator and the Android 35 **Google Play** system image. AVD is a Pixel 7 named
`tripvault`. Launch:
`%LOCALAPPDATA%\Android\Sdk\emulator\emulator.exe -avd tripvault -camera-back webcam0`
then `adb reverse tcp:8081 tcp:8081` and `npx expo start --dev-client`.

**Not started:** Phases 3–10. Phase 8 (F6) is additionally blocked on
`tripvault-entry-requirements-starter.md`, which does not exist — the setup doc
flags those IATA lookups as manual research.

**Test counts:** 55 unit (`npm test`), 42 live (`scripts/verify-f1.mjs`,
`scripts/verify-f11.mjs`).

**Email confirmation: currently OFF** (`mailer_autoconfirm: true`), so sign-up
works from the app and both verification scripts can run. This is a real hole —
anyone can register under an address they do not own — and must go back on before
real users. It has flipped several times; check rather than assume:
`curl -s -H "apikey: <publishable key>" https://<ref>.supabase.co/auth/v1/settings`

---

## 2026-09-05 — Phase 5 (F3): trips, attendees, checklist and bookings

The biggest core feature, and fully unblocked. 26/26 live checks pass
(`scripts/verify-f3.mjs`), plus 30 unit tests on the logic that carries
consequence.

**The six-month passport rule is the part worth getting right.** Naive month
arithmetic gets it wrong: 31 August plus six months is not 3 March, because
JavaScript's Date rolls the overflow forward. `addMonths` clamps to the end of
the target month, and the tests pin both that and the leap-year case.

Design decisions inside the rule:
- A dual national passes if ANY passport clears, and only the best one is
  reported. Nagging someone about the passport they were never going to use is
  noise, and F6 later recommends which to travel on.
- "Expires before the trip ends" is reported separately from "falls short of the
  six-month buffer". They are materially different problems and the wording
  differs.
- A passport with no expiry recorded is reported rather than silently passing,
  which is the failure mode that would matter most.

**Auto-generated checklist items are upserted, not appended.** A unique index on
(trip_id, source, label) where source is not manual means re-running the check on
every open updates rather than duplicating, and resolved issues have their items
removed so a fixed problem stops nagging. Manual items are exempt from that index
on purpose — two "call the hotel" reminders is the user's business.

**Deleting a booking clears a checklist link but keeps the item** (ON DELETE SET
NULL, verified). The opposite would quietly erase the task along with the
booking.

**The F6 seam is a real runtime probe, not a flag.** `isEntryRequirementCheckAvailable`
asks whether F6's `entry_requirements` table exists. So the fallback is genuinely
the live path today — the verifier asserts the table is still absent — and the
button starts working the moment Phase 8's migration lands, with no code change
and no flag anyone can forget to flip.

`trip_items.trip_id` is nullable from the start for F5's "Needs a trip" holding
area, with `user_id` alongside it so an unassigned item still has an owner for
RLS to scope. Retrofitting that onto a table holding real bookings would have
been worse.

Removed `screens/PlaceholderScreen.tsx`: both tabs that used it are now real.

---

## 2026-09-05 — Phase 4 (F4): loyalty programs

Straight CRUD, no external dependencies, so it went in whole. 14/14 live checks
pass (`scripts/verify-f4.mjs`).

**Migrations are now applied from here.** The Supabase SQL editor is reachable
through the browser session, so a migration no longer waits on someone pasting
it in. The editor warns "potential issue detected" on any `drop policy if
exists`, which every idempotent migration in this repo uses -- that prompt needs
confirming and is not a sign anything is wrong.

**Deliberately no unique constraint on (traveler_id, type).** Two airline
schemes is ordinary, and the test plan explicitly checks a one-per-type
constraint has not crept in. The only uniqueness is an exact duplicate row
(same traveler, provider and number), since the same provider twice is
legitimate -- a personal and a business membership.

**Membership numbers are stored in plaintext, per the feature plan**, which
rates them lower sensitivity than a passport number: personal, but not a
government-related identifier, so APP 9 does not apply. The UI masks all but the
last four characters, which is a shoulder-surfing courtesy rather than a
security control, and says so in the code so nobody later mistakes it for one.

The verifier includes a scope test with no functional equivalent: it asserts no
`balance`/`points`/`miles` column exists. F4 rules point syncing out, and that
is the kind of scope creep that arrives quietly.

**Pure helpers had to be split into `lib/loyaltyFormat.ts`.** `lib/loyalty.ts`
imports the Supabase client, which pulls in React Native and cannot load under
`node --test`. Any future module that wants unit tests needs the same split.

---

## 2026-09-05 — First run on a device, and what it found

Ran the whole Phase 2 UI on an Android emulator for the first time. Sign-up,
traveler profiles, the minor badge and the traveler picker all work. The session
survived a full app restart, so the chunked SecureStore adapter does what it was
written to do on a real device.

**The document scanner is a Google Play Services on-demand module, not part of
our APK.** Launching it triggered "Downloading updates to Google Play services"
and pulled `mlkit.docscan.ui`, `.crop`, `.detect`, `.enhance`, `.shadow` and
`.stain`. This matters for F1's offline story and is easy to get wrong:
- ML Kit **text recognition** models *are* bundled in our APK
  (`assets/mlkit-google-ocr-models/`), so OCR itself is genuinely offline.
- The **scanner UI** is not. A user's first scan needs a network connection,
  and on a device without Play Services it will not work at all.

So "extraction never leaves the device" remains true — nothing is uploaded — but
"works with no signal" is only true after the scanner modules have been fetched
once. Worth saying accurately in any user-facing copy, and worth a graceful
message when the download fails.

**Bug found and fixed: the Documents screen served stale data.** It fetched on
mount, and React Navigation keeps tab screens mounted, so a traveler added on the
Profile tab never appeared — the picker showed "add a traveler on the Profile tab
first" while two already existed. Fixed with `useFocusEffect`, plus a refresh
when the picker opens: the first fix alone was not enough, because the picker can
be opened without this screen ever losing focus. Only running the app finds this.

**Transient `JWT issued at future`** right after signup, from emulator clock
drift. Resolved by toggling `auto_time`; host and emulator now agree to within a
second. Not an app bug, but worth recognising rather than chasing.

**Cosmetic gaps, since fixed:** the tab bar rendered placeholder glyphs because
no `tabBarIcon` was supplied, and the "Add traveler" heading sat under the status
bar. The modal now applies `useSafeAreaInsets` -- a full-screen RN `Modal` is
outside the navigator, so it gets no header and no inset of its own. Tabs are
label-only for now; real icons need `@expo/vector-icons`, not yet a dependency.

Worth knowing for next time: setting `tabBarStyle: { height }` *replaces* the
navigator's own safe-area calculation rather than adding to it, so an explicit
height pushes the labels under Android's gesture handle. Adding `insets.bottom`
by hand did not fix it either. Supplying no `tabBarStyle` at all is correct.

---

## 2026-09-05 — First Android dev build, and an EAS environment trap

Build finished in ~10 minutes. APK is 230 MB (dev client plus every native
module). EAS project owned by `blackbirdzz-property`.

**EAS environment variables, and a correction.** EAS archives the project with
git, so a gitignored `.env` never reaches the builder, and `EXPO_PUBLIC_` values
are inlined at bundle time. On noticing the CLI's passing note ("No environment
variables ... found for the development environment") the first build was
cancelled on the assumption the APK would be unusable.

That assumption was wrong for a *development* build, and inspecting the APK
afterwards proved it: there is no `index.android.bundle` inside it. A dev build
ships no embedded JS — it loads from the Metro dev server at runtime, and Metro
inlines `EXPO_PUBLIC_` values from the **local** `.env`. The cancelled build
would have worked. The cancellation cost ten minutes and nothing else.

The variables are still right to have set, for the real reason: `preview` and
`production` builds *do* embed the bundle, and those would genuinely have
shipped with no credentials. Both are now EAS project environment variables
across all three environments.

The rule worth carrying: **development builds read the local `.env`; embedded
builds read EAS environment variables.**

They are set **plaintext, not secret**, deliberately: both are publishable by
design and extractable from any APK regardless, so marking them secret would
imply a protection that does not exist. The service role key and
DOCUMENT_ENCRYPTION_KEY must never be added here — an `EXPO_PUBLIC_` value is
compiled into the app.

**The Android keystore was generated in the cloud** (no local keytool). It is now
this app's signing identity; losing it means being unable to ship Play updates.
It lives in the Expo account, retrievable via `eas credentials`.

**Emulator limitation, worth not rediscovering:** an Android emulator cannot
meaningfully test the passport scanner. The camera is either a synthetic scene or
webcam passthrough, so scanning means holding a passport up to a laptop webcam
and hoping edge detection copes. Everything else in Phase 2 tests fine there —
auth, profiles, manual entry, the guardian gate, tap-to-reveal. The scan path
needs a real phone.

Also: the AVD must use a **Google Play** system image, not AOSP. ML Kit's
document scanner depends on Google Play Services, so on an AOSP image it fails
to initialise in a way that looks like our bug but is not.

---

## 2026-09-05 — Phase 2 UI, and the EAS build setup

Built the four screens completing F1. Configured `eas.json`, `expo-dev-client`
and camera permissions; verified with `expo config --type prebuild` that plugins
resolve, so a build failure will not be config-shaped.

**Native modules are behind a lazy require and degrade to manual entry.** The
first version of the availability check tested for the JS wrapper — which exists
in Expo Go even when its native half does not, so a missing dev build would have
surfaced as a raw TurboModule stack trace. Failures are now classified at call
time, with tests pinning that a genuine failure (denied camera permission) still
reads as an error rather than sending someone off to rebuild.

**Numbers are masked in the list and fetched one at a time on tap.** Every
decrypt is an Edge Function call written to the audit log; fetching on render
would fill that log with reads nobody asked for and make it useless for spotting
anything unusual.

---

## 2026-09-05 — Email confirmation turned OFF (owed)

Disabled so verification scripts could sign throwaway accounts straight in.
While off, anyone can register under an address they do not own — which matters
more here than in most apps, because F5 later treats a per-user forwarding
address as a credential.

Also worth knowing: with it on, Supabase's built-in SMTP rate-limits to a
handful of messages an hour and throttles ordinary development signups. Re-enable
alongside Phase 3's Postmark/Mailgun setup, when there is real SMTP.

Tracked in `docs/tripvault-setup-steps.md` and `CLAUDE.md`.

---

## 2026-09-05 — Document number encryption: Edge Function holds the key

Three options were weighed. **Chosen: the key lives only in the `documents` Edge
Function's `DOCUMENT_ENCRYPTION_KEY` secret.**

**Why not database-side (pgcrypto + Supabase Vault):** it puts key and data in
the same system. GDPR Art 34(3)(a) and Australia's NDB scheme both turn on
whether the keys were taken *with* the data — the regulators' own worked example
is that an encrypted database whose keys sat on the same compromised server does
**not** qualify for the notification exemption. Supabase has also deprecated
pgsodium Transparent Column Encryption and advises against it on
operational-complexity grounds.

**Why not client-side:** strictly stronger, and the right answer if F9 did not
exist. But F9 requires a different person on a different device to read
documents, which means envelope encryption with per-user key wrapping plus a
key-recovery story. Hand-rolled crypto with those moving parts is where solo
projects fail, and losing a device should not mean losing a child's passport
record. A botched client-side scheme is worse than a correct server-side one.

**Consequences that must not be undone:**
- `documents` has **no INSERT or UPDATE policy** for authenticated users. Writes
  go through the Edge Function; the client keeps SELECT (ciphertext is harmless)
  and DELETE (needs no key). Adding a policy would defeat the whole design.
- The column is `document_number_encrypted`, CHECK-constrained to the envelope
  shape, so plaintext is a database error rather than a code-review question.
- The document id is bound in as AES-GCM additional authenticated data, so
  ciphertext copied onto another row fails to decrypt instead of returning
  someone else's number.
- **Losing the key means every stored document number is unrecoverable.** That
  is the accepted trade for a database compromise being survivable.

**Still open:** the passport *scan* is protected by bucket privacy, owner-scoped
policies and 60-second signed URLs, but its bytes are not encrypted under our
key. The image contains everything the number does and more, so this is a real
gap, noted in `supabase/migrations/0002_documents.sql`.

**Testing note:** the SQL verifier switches to the `authenticated` role and
impersonates a real user before checking RLS. The SQL editor runs as a superuser
that bypasses RLS entirely — checking it as the default role would pass while
proving nothing.

---

## 2026-09-05 — F1 extraction moved on-device, replacing the Claude API

The feature plan originally specified Claude vision for MRZ extraction. Changed
to on-device: ML Kit OCR plus the `mrz` package for parsing and check digits.

**The plan's own reasoning pointed here.** It already specified reading the MRZ
rather than interpreting the page, *because* each field carries a check digit and
can be validated arithmetically. Once that holds, the parse is deterministic and
the only hard part is character recognition — which the same native frameworks
the scanner already wraps do locally. The hosted model was doing OCR the device
does anyway, while adding a network round trip, a per-scan cost, and a third
party in the path of the most sensitive data the app holds.

**Consequences:** no Anthropic key needed for F1, extraction works offline, one
fewer vendor DPA. F5's booking extraction keeps the Claude API, where the input
genuinely is unstructured text.

**Deliberate non-obvious choice:** ambiguous characters (O/0, I/1, S/5, B/8) are
*not* corrected during normalisation. Both readings are legal and correctness
depends on field position; the `mrz` package resolves them per field under
check-digit constraint, which beats a blind global replace. Only characters
*illegal* in an MRZ are mapped, where substitution cannot destroy a real value.

**Accepted limitation:** ML Kit is a general text recogniser, not a dedicated MRZ
SDK. Damaged or glare-affected pages will fail more often than with a commercial
reader (BlinkID, Regula) and land the user in manual correction.

**Bug the tests caught:** expiry century windowing pushed anything over ten years
old into the next century, turning the ICAO specimen's 2012 expiry into 2112. The
bound is asymmetric — a passport runs at most ten years so an expiry is never far
*ahead*, but people scan long-expired passports out of drawers, so the past side
must stay open.

**Fixture note:** ICAO's specimens issue from the fictional "UTO", which the
`mrz` package rejects as an unknown state code. Substituted AUS — issuing state
and nationality sit outside every check digit's range, so the checksums survive.
Supabase separately rejects `example.com` and reserved TLDs like `.test`, hence
`@tripvault.local` in the verifier scripts.

---

## 2026-09-05 — Phase 1 built twice; a security bug found in the survivor

A second Claude Code session built Phase 1 (commits `a08a267`, `98c028c`) while
this session was building the same thing. Its implementation was kept — it was
better in three places (a `TIER_PROFILE_LIMITS` seam for Phase 6, an
`impliesMinor()` helper, a unique index on `linked_auth_user_id`). The duplicate
was discarded.

**Lesson: check `git log` before starting a phase.** More than one session may be
running against this repo.

**The bug:** its `is_minor` trigger was declared `before insert or update **of
relationship**`. A column-scoped trigger fires only when that column appears in
the UPDATE's SET list, so `update travelers set is_minor = false` never fired it
and the forged value persisted. RLS permits exactly that write on the user's own
row, so it was reachable from any direct API call — defeating F1's guardian gate,
which keys off the flag. Fixed in `3f8fdf9`; both verifiers gained the case that
would have caught it, and it now passes live.

---

## 2026-09-05 — Phase 0

Expo scaffold, auth, three-tab shell.

**`.gitignore` trap:** Expo's default template ignores `.env*.local` but not
`.env`. Following Phase 0's prompt literally would have committed the Supabase
keys in the very first commit. Fixed and verified with `git check-ignore` rather
than eyeballed.

**Session storage is the device keychain, not AsyncStorage.** AsyncStorage is
plaintext on disk, which is the wrong trade for a session that unlocks passport
data. `lib/secureStorage.ts` chunks the value because SecureStore caps entries at
~2048 bytes and a Supabase session exceeds that; it fails closed, reporting "no
session" on a partial write rather than handing Supabase corrupt JSON.
