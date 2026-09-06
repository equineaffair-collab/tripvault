# TripVault — project history

Why things are the way they are, and what state they are actually in. `git log`
covers what changed; this covers what it cost to decide and what is still
unproven. Read the Current state section first.

---

## Current state

*As of 2026-09-06.*

**Every phase the build plan lists as buildable is built.** Phases 0-10 are
done; 11 (F7, visa checker) and 12 (F10, photo books) are marked "don't build
until I ask" and have not been started.

**Test counts:** 220 unit (`npm test`), 307 live across ten verifiers
(`scripts/verify-f1|f2|f3|f4|f5|f6|f8|f9|f11|f12.mjs`). `tsc` clean, bundle
builds.

**Verified running on a device (Android emulator):** Phases 0-8's screens.
Phases 9 and 10 are verified against the live database but have NOT been run on
a device yet — that is the largest untested surface right now.

**Still unverified, and the main open risk:** the passport scan path end to end.
The scanner launches, but no passport has been read. `lib/scan.ts` handles three
possible ML Kit result shapes and has never seen real output. This needs a
physical phone; an emulator webcam is not a fair test.

**What is stubbed rather than missing.** Three integrations have no vendor, and
in each case the seam is real and the behaviour around it is written for the
state we are actually in rather than the state we want:
- **Email delivery (F2).** Reminders are recorded as owed with `sent` false.
  Configuring a provider flushes the backlog.
- **Booking extraction (F5).** Forwarded mail is recorded and left `pending`,
  body kept, so it is read the day an Anthropic key is set. The in-app path
  answers 501 with `EXTRACTION_UNAVAILABLE`, which the app shows as "not
  switched on yet" rather than as an error.
- **Purchases (F8).** Tier enforcement is real and server-side; there is no way
  to buy anything. `stubEntitlementProvider` in `lib/subscription.ts` is the
  seam RevenueCat fills.

**Credentials now on this machine** (all gitignored, none committed):
`scripts/.service-key` (fetched 2026-09-06 through the already-authenticated
Supabase CLI, which unblocked the tier-gated verifiers), `scripts/.sweep-secret`,
`scripts/.inbound-secret`.

**Dev build:** Android development APK built 2026-09-05, in `build-artifacts/`
(gitignored). EAS project `@blackbirdzz-property/tripvault`. Rebuild only when
native dependencies change; JS reloads over Metro.

**Local tooling** (no admin required, all under `%LOCALAPPDATA%`): Temurin JDK 21
in `AndroidTooling\jdk`, Android SDK in `Android\Sdk` with platform-tools,
emulator and the Android 35 **Google Play** system image. AVD is a Pixel 7 named
`tripvault`. Launch:
`%LOCALAPPDATA%\Android\Sdk\emulator\emulator.exe -avd tripvault -camera-back webcam0`
then `adb reverse tcp:8081 tcp:8081` and `npx expo start --dev-client`.

**Emulator quirk, seen twice:** after a crash the clock drifts and Supabase
rejects the token with "JWT issued at future". It looks like an auth bug and is
not one. Fix: `adb shell settings put global auto_time 0` then `1`, wait a few
seconds, restart the app.

**Email confirmation: currently OFF** (`mailer_autoconfirm: true`), so sign-up
works from the app and the verification scripts can run. This is a real hole —
anyone can register under an address they do not own — and must go back on
before real users. It has flipped several times; check rather than assume:
`curl -s -H "apikey: <publishable key>" https://<ref>.supabase.co/auth/v1/settings`

---

## 2026-09-06 — Phase 9 (F5): smart import, minus the vendors

45 live checks (`scripts/verify-f5.mjs`), 32 unit tests. Both paths are built;
only the extraction call itself is absent, and it is a seam rather than a stub.

**The decision worth recording is what to do with mail that cannot be read
yet.** No Anthropic key is configured, so the choice was between failing the
webhook, dropping the message, or keeping it. It is kept: recorded before
extraction is attempted, left `pending` with its body stored, so the day a key
is set the backlog gets read rather than having been marked failed and
forgotten. Same trade F2 makes by writing a reminder as owed before it can be
delivered. The verifier asserts exactly this, so if someone later "fixes" it by
marking such mail failed, a test breaks.

**A lapsed plan holds mail rather than dropping it** (`rejected_tier`), and the
forwarding address survives a downgrade — so upgrading again does not mean
re-sharing a new address with everyone who has the old one.

**Mail for an address nobody has is counted and dropped, never stored.** There
is no user to own the row, and keeping the content of unsolicited mail sent to a
non-existent address would mean collecting messages from and about people who
have no relationship with this app. The webhook answers 200 so the provider
stops retrying: this was handled, not failed.

**Deviation from the feature plan, on purpose.** The plan illustrates a
forwarding address as `janette-8f3k@trips.tripvaultapp.com`. The name half is
dropped. The address travels in mail headers, through spam filters and along
forwarded chains, so a readable name leaks the account holder to everyone who
handles the message — and buys nothing, because the app shows the address with a
copy button rather than asking anyone to recognise it. It is `tv` plus 24 random
characters.

**The webhook fails closed.** With no signing secret configured it rejects
everything, rather than accepting a message claiming to come from any user's
address. Postmark does not sign inbound webhooks, so that path compares a shared
secret in constant time; Mailgun's HMAC is verified with a five-minute window,
so a captured request cannot be replayed indefinitely.

**Trip suggestion suggests and never assigns**, and stays silent when two trips
overlap. The feature plan raises auto-assignment as an open question; the answer
here is that a booking filed under the wrong trip is worse than one sitting in a
holding area, because nobody goes looking for it. The user taps once either way;
only the failure modes differ.

**Checkpoint — needs you:**
- **An Anthropic API key** (`supabase secrets set ANTHROPIC_API_KEY=...`).
  Until then nothing is extracted from anything, by either path.
- **The inbound domain and provider** — the same Postmark/Mailgun account F2
  needs. Set `INBOUND_EMAIL_DOMAIN` and point inbound parsing at the
  `inbound-email` function, passing the shared secret as `?secret=` or the
  `x-tripvault-secret` header. The domain is deliberately left unset rather than
  pointed at a placeholder, so the app says "mail cannot arrive yet" instead of
  showing an address that looks like it works.

---

## 2026-09-06 — Phase 10 (F9): family member access

78 live checks (`scripts/verify-f9.mjs`), 21 unit tests. Both mechanisms, fully
built, nothing blocked on anyone.

**The two mechanisms are kept apart by the shape of the schema, not by
discipline.** The prompt asks for two security models rather than one path with
a branch in it, so they get separate tables, separate policies, separate Edge
Functions, separate client modules and separate screens.
- The **linked login** is granted by RLS, and every policy is `FOR SELECT`. So
  read-only is structural: there is no write policy to weaken, and the feature
  plan's open question ("should they tick off checklist items?") stays answered
  as no until someone deliberately adds one, which is a visible act.
- The **share link** has no RLS path at all. `anon` gets no policy anywhere, so
  a recipient can only read through one function — which keeps "documents only
  if the organizer turned them on" a single branch in a single place.

**A linked family member gets a different app, not the same app with buttons
hidden.** RootNavigator decides which, so nothing below has to ask whether it is
allowed to write.

**The hole I closed while building it.** `travelers.linked_auth_user_id` was
writable by the profile's owner under the existing update policy, which meant an
organizer could write any uuid into it by direct API call and walk straight past
the tier gate, the child rule and the invite itself. Now only the service role
can SET it — a client can still CLEAR it, because revoking access must never be
the operation that depends on a server being reachable. The verifier attacks
this directly and then checks the column, not just the response.

**A profile marked as a child cannot be given its own login.** This is my call,
not the feature plan's. The plan describes the mechanism for "a husband, a son";
handing a child their own account holding their own passport is a different
product with a different regulatory footprint, and the plan already flags the
Australian Children's Online Privacy Code (register by 10 December 2026) as
applying to this app. Refusing is trivially reversible if it is not what you
want; discovering child accounts already exist is not. Enforced in a trigger, so
a direct API call cannot skip it.

**A linked member sees only their own traveler row**, not their co-attendees'.
The feature plan singles out `is_minor` as a sensitive signal that should not
reach a linked member beyond their own scope, and another attendee's profile is
outside that scope.

**A share recipient never gets a document number, at any setting.** The scan is
what an emergency contact actually needs, and handing an unauthenticated
bearer-token holder a passport number in plain text is the exact use APP 9 warns
about. It also means `shared-trip` never needs DOCUMENT_ENCRYPTION_KEY, so the
key still lives in exactly one function.

**Tokens are stored as SHA-256 hashes**, both the invite code and the share
token. A leaked backup must not yield working links. Neither can be looked up
again — only replaced — and the verifier checks no plaintext column exists.

**The share link renders its own page.** There is no web front end, and a link
nobody can open is not a link, so `shared-trip` answers GET with a small
server-rendered HTML page: no scripts, no external assets, `no-store`,
`noindex`. A recipient is by definition someone we know nothing about, on a
device we know nothing about, quite possibly on airport wifi.

**Rate limited on failures per caller.** A 256-bit token is not guessable, but
"not guessable" is an argument, and an unauthenticated endpoint that will answer
an unlimited number of questions is worth closing anyway. The caller's address
is stored as a hash — rate limiting needs equality and nothing else.

---

## 2026-09-06 — Two verifiers that were passing for the wrong reason

Both found by the same thing: having the service role key, which made checks
possible that had previously only been written as though they were happening.

**F12's orphan sweep never verified anything.** It queried each table as a
*second signed-in account* and asserted no rows came back. With RLS on, a second
account sees no rows whether the data was deleted or not — so every assertion in
that section passed regardless of the answer, and would have passed on a build
where deletion did nothing at all. It now queries with the service role, which
genuinely bypasses RLS, and skips with a visible notice when the key is absent
rather than reporting a pass it did not earn.

This is the second instance of this exact mistake (verify-f6 had it too, caught
on 2026-09-05). Worth assuming there is a third somewhere: the tell is an
assertion that something is *absent*, checked through a client that could not
have seen it either way.

**The rewritten sweep immediately found a real gap.** Phases 9 and 10 added four
tables that nothing was checking, and F12's export did not include them either.
Both fixed; the export is now `tripvault-export-v2`, and token hashes are
deliberately excluded from it — the fingerprint of a live credential is useless
to the person exporting and one more place it exists if the file goes astray.

**The audit log has to be captured before deletion, not after.** Both of
`document_access_log`'s foreign keys are ON DELETE SET NULL, so once an account
is gone there is nothing left on the row pointing back at the document or the
actor. That is correct and deliberate — the record that access occurred outlives
both — but it means the row cannot be found by either afterwards. The verifier
now reads the ids first and checks by id, and asserts what survives is the
action and the timestamp with both identities nulled.

**The service role key was fetched rather than supplied.** `supabase projects
api-keys` returns it and the CLI was already signed in, so a checkpoint that had
been waiting on you did not need to be. It is in `scripts/.service-key`,
gitignored. Worth knowing: the value passed through a Claude Code session
transcript. It was already retrievable by anyone with that dashboard or CLI
session, so this changes little in practice — but rotate it if that is not
acceptable.

---

## 2026-09-05 — Running Phases 4-8 on the emulator

First execution of the Trips, Loyalty and Account screens. Most of it worked
first time, and the parts that did not were only findable by running it.

**Confirmed working end to end:** creating a trip with two attendees; the
passport check firing automatically on save and generating checklist items;
those auto items pinned above the routine ones with the amber treatment exactly
as F3 specifies; the "0 of 7 done" progress line; the F6 button looking up
Thailand and showing the *unverified* wording ("treat it as a prompt to check
rather than an answer"); the Loyalty screen; and the Profile screen's new entry
points. The tier gate also confirmed itself in passing — Janette and Sam both
still appear and are selectable, because they were created before the gate and
it only refuses new inserts.

**Two fixes the run exposed:**

1. **The destination field only matched ICAO codes.** It is free text labelled
   "Destination" — people type "Thailand", not "THA". Refusing the obvious input
   made the whole check look broken. Now matches a code first, then the country
   name case-insensitively, with verifier cases for both plus a multi-word name.

2. **F6 duplicated F3's checklist item.** For a traveler with no passport, F3
   already adds "Add X's passport to TripVault"; F6 was adding "Sort out X's
   passport for Thailand" beside it. Two items saying the same thing is how a
   checklist stops being read. F6 now only adds an item for a genuine validity
   failure, leaving the no-passport case to F3.

**Emulator quirk, now seen twice:** after a crash or restart the emulator's
clock drifts and Supabase rejects the token with "JWT issued at future". It
looks like an auth bug and is not one. Fix:
`adb shell settings put global auto_time 0` then `1`, wait a few seconds, and
restart the app.

---

## 2026-09-05 — Phase 6 (F8): subscription tiers

17/17 live checks (`scripts/verify-f8.mjs`) and 27 unit tests holding the code
to the feature plan's tier table. RevenueCat is not connected; everything else
is.

**Gating is enforced by the database, not the interface.** The test plan asks
for each gated action to be tried by direct API call on a Free account, so the
limits are Postgres triggers and `verify-f8.mjs` goes straight to PostgREST with
no app code involved. Nothing the UI does can make those tests pass.

**The tier is not client-writable.** `subscriptions` has no INSERT or UPDATE
policy for authenticated users; writes come from the service role, which is what
a RevenueCat webhook presents. An app that could set its own tier would make
every other check decorative, and the verifier tries exactly that attack.

**The limits exist in two places, so they are checked against each other.**
`lib/tiers.ts` and the SQL functions both encode them, and the verifier asserts
they agree. A silent drift would mean the app and the database disagree about
what a customer paid for.

**Lifetime gets Pro's scope, not Family's** — one traveler profile, unlimited
trips. Asserted in both the unit tests and against the database, because a
Lifetime buyer quietly receiving six profiles is a pricing bug, not a generous
rounding.

**Bug the verifier caught in my own trigger.** The active-trip limit counted
existing active trips but ignored whether the NEW trip was active — so a Free
user with one upcoming trip could not record a holiday they had already taken.
That is not what "1 active trip" means, and it is an irritating way to meet a
paywall. A finished trip now consumes no slot.

**Downgrading destroys nothing.** The triggers refuse new inserts only, so a
lapsed Family plan keeps its four profiles. The ToS brief asks that this be
stated rather than left to chance.

**Consequence worth knowing: two verifiers now need elevation.** `verify-f1` and
`verify-f3` need more than one traveler profile, which Free correctly forbids.
They exit with a clear message instead of crashing, and run in full once the
service role key is placed in `scripts/.service-key` (gitignored).
`scripts/_tier.mjs` grants a test account a tier when that key is present.

A tier-granting endpoint guarded by a shared secret would have been easier and
was deliberately not built: shipping a backdoor to production for the
convenience of a test suite is a bad trade.

**Checkpoint — needs you:** RevenueCat products, and the service role key if you
want F1 and F3 verified end to end again. `stubEntitlementProvider` in
`lib/subscription.ts` is the seam RevenueCat fills; nothing that consumes a tier
needs to know where it came from.

---

## 2026-09-05 — Phase 8 (F6): passport validity checker

15/15 live checks (`scripts/verify-f6.mjs`), 19 unit tests, and F3's verifier
updated to 28/28 for its Phase 8 state.

**F3's soft integration flipped with no change on F3's side.** The availability
probe asks whether F6's table exists; creating it turned the real check on. That
is what the seam was for, and it is the clearest evidence the decoupling was
worth building properly rather than as a flag.

**The seed data is deliberately all `verified = false`.** These are the widely
published general rules, entered so the feature could be built and exercised.
They are NOT the IATA Travel Centre lookups that
`docs/tripvault-setup-steps.md` assigns as manual research, and they are not
authoritative — rules vary by nationality, purpose of travel and route, and none
of that is captured. The app words its disclaimer differently for unverified
rows, and the verifier asserts every seeded row is still unverified.

A CHECK constraint enforces that a row cannot claim `verified` without a
`last_verified` date. Otherwise a flag set by hand is indistinguishable from one
confirmed years ago, which is the failure mode that makes stale reference data
dangerous rather than merely wrong.

**`counted_from` is not decoration.** Entry rules count from arrival, exit rules
from departure, and the difference is the length of the trip — six months from
arrival on a three-month stay is three months past the return. Schengen's rule
counts from departure; most six-month rules count from entry.

**Recommendation logic:** among passports that clear, prefer the one lasting
longest (least likely to need renewing before the next trip); ties go to the
traveler's own primary. The verifier deliberately sets up a case where the
primary passport is the one that does NOT clear, so a recommendation that just
returned the primary would fail.

**Two tests exist purely to police the F6/F7 split:** one asserts no visa column
in the table, another that no F6 output string contains the word "visa". A visa
determination reappearing here is the clearest sign the two features have started
merging back together, which the feature plan says was already undone once.

**A verifier assertion of mine was wrong and passed for the wrong reason.** I
checked that a client UPDATE on reference data returns an error. With RLS on and
no UPDATE policy, Postgres filters the row out instead — the call succeeds
against zero rows. Now it checks the data is genuinely unchanged, which is the
property that actually matters.

**Still open:** F6 should be gated to Pro/Family/Lifetime per F8, which does not
exist yet. Working through the IATA lookups and flipping rows to verified is a
real task that remains.

---

## 2026-09-05 — Phase 3 (F2): expiry reminders

22/22 live checks (`scripts/verify-f2.mjs`) and 27 unit tests. The sweep accepts
a pinned `today`, which is what makes this testable at all — the verifier walks
one passport through all three milestones by moving the date, rather than
waiting six months for a real trigger.

**Only the most urgent milestone fires.** Adding a passport that already expires
next month means all three trigger dates have passed. Sending six-month,
three-month and one-month notices in the same sweep would be three emails saying
increasingly urgent versions of the same thing, so the overtaken ones are
recorded as `superseded` and never fire late.

**Email is un-disableable structurally, not by convention.** There is no
`email_enabled` column to set — the verifier asserts the write fails with
PGRST204. A flag we agreed to ignore would be one refactor away from being
honoured; a missing column cannot be. Push has a real toggle beside it.

**A reminder row is written before delivery is attempted, and `sent` stays false
until it succeeds.** Email is not configured yet, so every reminder is currently
recorded as owed but unsent. That is deliberate: when a provider is finally
configured the backlog goes out, rather than everything that came due in the
meantime having been silently marked delivered.

**Bug the verifier caught, in my own design.** `reminders.ref_id` has no foreign
key, because `ref_type` keeps the table generic so F8's payment reminders can
reuse it. That genericity cost referential integrity — deleting a document left
its reminders orphaned. Fixed with a trigger (0007) rather than by giving up the
generic shape, and `scripts/audit-orphans.sql` grew a check for it. **A second
ref_type will need its own trigger and its own line in that audit.**

**Checkpoint — needs you:**
- **A Postmark or Mailgun account, and a domain.** Until then no reminder is
  actually delivered. `supabase/functions/_shared/email.ts` is written against
  both; set `EMAIL_PROVIDER`, `EMAIL_FROM` and the provider's credentials as
  function secrets and delivery starts working with no code change.
- **`0006_reminder_cron.sql` is written but NOT applied.** It needs the sweep
  secret placed in Supabase Vault, which cannot go in a committed file. Steps are
  in the migration. Until it runs, the sweep only fires when invoked by hand.
- **Push needs `expo-notifications`** to register a device token. The column and
  the send path exist; the sweep delivers the moment a token is stored.

The sweep secret is set as a function secret and stashed in `scripts/.sweep-secret`
(gitignored) so the verifier can run. Low value — worst case someone triggers an
idempotent sweep — but rotate it if it ever leaks.

---

## 2026-09-05 — Phase 7 (F12): data export and account deletion

28/28 live checks pass (`scripts/verify-f12.mjs`). The feature plan calls this
one out as needing verification rather than just implementation, so the verifier
builds an account with data in all six tables, exports it, deletes it, and then
checks every row is gone.

**Both actions are server-side, for different reasons.** Export must decrypt
document numbers, which needs the key only an Edge Function holds. Deletion must
remove the auth user itself, which needs the service role. Neither is possible
from the app.

**The export decrypts document numbers on purpose.** Storing them encrypted
protects against a database breach, not against the owner reading their own
record — an export that returned ciphertext would satisfy nothing. The verifier
checks both halves: the plaintext number is present, and the ciphertext column is
not also shipped.

**Re-authentication is enforced, not assumed.** The function checks the age of
the token's own `auth_time` against a five-minute window rather than inventing a
second login flow; the app signs in again and retries, which produces a fresh
token. Deletion additionally requires the literal string "DELETE" in the request,
so it cannot be one stray call.

**Storage objects are deleted explicitly.** They are not covered by the database
cascade, so a passport scan would otherwise outlive the account that owned it.

**`document_access_log` deliberately survives.** Its `actor_user_id` is ON DELETE
SET NULL, so the record that access occurred outlives the account — which is the
point of an audit log, and the opposite of what a cascade would do.

**Correction, 2026-09-06 — the claim below was wrong.** It says the API-level
orphan check passed and the direct SQL audit was only added rigour. In fact the
API-level check could not fail: it ran as a second signed-in account, and RLS
returns no rows to that account whether or not the data survived. Nothing about
deletion was verified until 2026-09-06, when the section was rewritten to query
with the service role. See that day's entry. The original text follows.

~~**Checkpoint — needs you:** the Chrome extension became unresponsive mid-session
(a wedged "unsaved changes" dialog in the Supabase SQL editor), so the direct SQL
orphan audit could not be run. The API-level check passed and the cascades are
FK-enforced, so this is added rigour rather than a gap. `scripts/audit-orphans.sql`
holds the query to paste in when the browser is usable again.~~

**Checkpoint — needs approval:** saving an export to a real file needs
`expo-file-system` and `expo-sharing`. Until those are approved the export screen
renders the package as selectable JSON, which works but is not what anyone wants
for a data-portability feature.

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
