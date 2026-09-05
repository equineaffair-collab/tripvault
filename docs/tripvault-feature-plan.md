# TripVault — feature plan

Living document. Update this file directly as features evolve — it's the source of truth the development plan gets derived from, not the other way around.

---

### F1 — Passport, visa and ID vault

**Status:** planned
**Priority:** core
**Description:** Store passport, visa and ID details per traveler, with expiry tracked.
**How it works:** User scans a document using a native camera scanner (auto edge-detection, straighten, crop — not just a plain photo), or uploads an existing photo/PDF. For passports specifically, extraction reads the machine-readable zone (MRZ) — the two standardized lines at the bottom of the photo page — rather than trying to interpret the whole page visually. Each MRZ field carries a check digit, so the extracted data can be mathematically validated for internal consistency before it's shown to the user, catching misreads rather than just hoping the model got it right. User confirms or corrects the pre-filled fields before saving, regardless of how confident the extraction was. Supports more than one passport per traveler (dual/multiple nationality), with one marked primary.
When a traveler profile's relationship field indicates a minor (e.g. "child") — a flag owned by F11, not this feature — document entry for that profile requires an explicit acknowledgment first — something like "I confirm I am this child's parent or legal guardian and am entering this on their behalf" — shown once per profile, not buried in general account signup. This isn't just a legal formality: it's the actual point in the app where a genuine, evolving compliance question (see the terms & conditions section) becomes a concrete product requirement. Minor profiles should also apply stricter data minimization than adult ones — capture only what F1 functionally needs (document type, number, expiry, country) and skip any optional extra fields for that profile specifically.
**Depends on:** F11 (traveler profiles must exist before documents can attach to one)
**Related to:** F2, F6
**Security notes:** Document numbers encrypted at rest. Extraction runs entirely on-device (see technical stack notes), so a passport image is never transmitted to any third party for reading — the scan reaches Supabase Storage as a stored file and nowhere else. This is the most sensitive data category in the app — treat accordingly in storage and access design. Minor profiles carry additional regulatory weight (COPPA's actual-knowledge trigger in the US, Australia's incoming Children's Online Privacy Code, GDPR's general child-data protections) — see the terms & conditions section for the full picture; this entry covers the product-level requirement (the acknowledgment + minimization above), not the legal analysis.
**Technical stack notes:** `react-native-document-scanner-plugin` (Expo-compatible, wraps native Apple VisionKit / Google ML Kit document scanners — needs a dev build, not Expo Go) for the capture UX; Supabase Storage for files; encrypted field for document_number. MRZ extraction runs on-device: `@react-native-ml-kit/text-recognition` (Google ML Kit, iOS + Android) OCRs the cropped scan, positional character correction fixes the standard OCR-B confusions per field type (in numeric fields O→0, I→1, S→5, B→8; reversed in alphabetic ones), and the `mrz` package parses the lines and validates every check digit. Documents with no MRZ fall back to manual entry via the same confirm-or-correct form.
**Design note — why on-device rather than a vision model:** an earlier draft sent the scan to the Claude API. That was reconsidered, because this entry's own reasoning argues against it: the MRZ is a fixed-width, machine-readable string whose fields carry check digits, so once the characters are read the parse is deterministic arithmetic, not interpretation. The hard part is OCR, which the same native frameworks the scanner already wraps do natively. Moving it on-device costs nothing in accuracy the check digits don't already catch, and buys three things a hosted model can't: the passport image never leaves the phone, extraction works with no signal, and there is no per-scan cost. It also removes one vendor from the data processing agreements the security review lists for this feature. The trade is that ML Kit is a general text recognizer rather than a dedicated MRZ SDK — a damaged or glare-affected page will fail more often than it would with a commercial reader like BlinkID or Regula, and land the user in manual correction. Acceptable, given the user confirms every field before saving regardless. F5 keeps the Claude API, where the input genuinely is unstructured free text.
**Open questions:** none
**Pricing note:** Confirmed free-tier. Since extraction moved on-device it carries no marginal cost at all, so the question of whether gating it would pay for itself is now moot rather than merely answered — there is nothing left to gate. Contrast with F5's booking auto-extraction, which does call a paid API per use, is genuinely recurring per trip, and remains the feature actually worth gating on cost grounds.

### F2 — Expiry reminders

**Status:** planned
**Priority:** core
**Description:** Reminders before a document expires, escalating in channel as the deadline approaches.
**How it works:** Daily scheduled job checks all documents for expiry dates 6/3/1 months out and creates a reminder record per milestone. Channel escalates with urgency rather than firing the same channel three times: 6 months out sends email only; 3 months out sends email + push; 1 month out sends email + push and shows a persistent in-app banner on next open. Email is the durable primary channel — it doesn't depend on notification permissions, survives a phone change, and sits in the inbox until read, rather than a push that can be swiped away and forgotten. Push is a convenience layer on top, not a substitute for it. Email for this reminder type is not user-disable-able even though push can be toggled off in settings — letting both channels be silenced would mean the app's core promise (won't get caught out by an expired document) silently stops holding, with no warning to the user that it's happened.
**Depends on:** F1
**Related to:** none
**Security notes:** none identified
**Technical stack notes:** Supabase Edge Function + pg_cron for scheduling; Expo push notifications; transactional email via Postmark or Mailgun — the same provider F5 already needs for inbound confirmation-email parsing, so this is one vendor covering both jobs rather than two.
**Open questions:** none

### F3 — Trip folder and manual booking entry

**Status:** planned
**Priority:** core
**Description:** A trip holds who's going, a checklist of what needs organizing, and every booking — flights, hotels, car hire, transfers, activities — in one place.
**How it works:** User names the trip and sets dates, then selects which of their own traveler profiles (managed in F11) are attending (multiple attendees is a Pro/Family-tier behavior, consistent with F8 — this is selecting existing traveler profiles, not sharing the trip with someone outside the account, which is F9's job and works differently — see F9). On save, the app automatically checks every attendee's passport(s) against the trip dates for the standard 6-month-validity rule and notifies the user if anyone needs to renew before departure — this reuses F1's document data directly and doesn't wait for the user to think to check it themselves.
The trip screen has a "Check entry requirements" button — this is a soft integration point with F6, not a hard dependency, deliberately, since the two are planned to be built together but don't have to be. If F6 exists and is wired up, pressing it runs the real check and, for anything it flags (e.g. a required e-visa), automatically adds a checklist item. If F6 hasn't been built yet, the button shows a plain "Entry requirement checking isn't available yet — check back soon" message instead of erroring or being hidden entirely. This keeps F3 fully functional and shippable on its own regardless of F6's build status, and means F6 can be developed and tested independently too, without a real trip record needing to exist first — a mocked destination and date range is enough to test it standalone.
The trip checklist is a flat, groupable checklist (not a dropdown) — checklists are more scannable for "what's still outstanding," which is the actual job here. Design details: group into a small number of categories (Documents, Bookings, Money & insurance) once a trip has more than 6–8 items; visually pin auto-generated, deadline-driven items (passport renewals, required visas) above routine planning tasks (book flights, arrange transfers) with a warning treatment, since the two carry very different urgency; show a progress indicator ("6 of 9 done") at the top of the trip screen so outstanding work is visible before opening the checklist itself. Default checklist items (customizable, not fixed): flights, accommodation, travel insurance, airport transfers, notify bank of travel — plus whatever F1 or F6 auto-add. A checklist item should be linkable to the actual trip_item once booked (auto-mark done when a matching item is added, or link manually), so the checklist doesn't become a second, disconnected source of truth alongside the real bookings.
**Depends on:** F1 (attendee passport check — this one's a real hard dependency, since it's just reading data F1 already owns), F11 (attendee selection needs traveler profiles to select from)
**Related to:** F4, F5, F6 (soft integration, see above — not a build dependency), F9 (a completely separate mechanism for showing the trip to someone outside the account — no overlap with attendee selection here)
**Security notes:** Attendee selection only exposes traveler profiles already owned by the account holder — no cross-account data access in this version. F9's read-only sharing link is a fully separate access path with its own scoping, not an extension of this.
**Technical stack notes:** Supabase tables: trips, trip_travelers (join table: trip_id, traveler_id), trip_items, trip_checklist_items (id, trip_id, label, category, status, source [manual/auto-passport/auto-entry-requirement], linked_trip_item_id nullable). The F6 integration point should be built behind a simple check (does the entry-requirement functionality exist / is it enabled) rather than assuming it's always present, so the "check back soon" fallback is a real code path, not an afterthought.
**Open questions:** none

### F4 — Loyalty program ID storage

**Status:** planned
**Priority:** core
**Description:** Store frequent flyer / loyalty membership numbers per traveler for quick reference when booking.
**How it works:** User adds provider name + membership number per traveler; supports multiple programs per traveler. Storage only — no automatic points-balance syncing.
**Depends on:** F11 (traveler profiles must exist before a loyalty program can attach to one)
**Related to:** F3
**Security notes:** Membership numbers are lower sensitivity than passport numbers but still personal — no encryption strictly required, but don't expose in shared-trip views (F9) without the traveler's own access.
**Technical stack notes:** Supabase table (loyalty_programs).
**Open questions:** Whether to auto-suggest a stored number when adding a matching-airline flight — nice-to-have, not required.

### F5 — Email and photo auto-extraction for bookings

**Status:** planned
**Priority:** nice-to-have
**Description:** Forward a confirmation email or snap a booking photo, and it becomes a trip item automatically.
**How it works:** Two genuinely different interaction models, worth keeping distinct rather than treating as one flow:

*Path A — photo/PDF, synchronous, fully in-app.* Same mechanic as F1's passport scanning, pointed at booking fields instead. Inside a trip, user taps "Add item," picks a type, then scans or uploads a photo/PDF. Sent to Claude for extraction, form pre-fills, user confirms/corrects, saved directly to that trip.

*Path B — email forwarding, asynchronous, outside the app at the moment of capture.* Every user gets one fixed, unique forwarding address on sign-up (shown on Profile with a copy button, e.g. janette-8f3k@trips.tripvaultapp.com). The user forwards a confirmation email from their own inbox using their own email app's normal Forward button — no TripVault screen is open at that point. The email lands with the inbound provider (Postmark/Mailgun), which hands it to a backend function, which sends it to Claude for the same extraction as Path A. The address itself is the security boundary — unique and unguessable per user, so anything arriving there is trusted as theirs without separate verification at forward-time. Because the user wasn't inside a specific trip when forwarding, the app can't know which trip it belongs to — it lands in a "Needs a trip" holding area instead, and the user assigns it to the right trip next time they open the app. The user-facing shape of this path is really: forward the email like normal, then later tell the app which trip it belongs to — it's a two-step, asynchronous flow, not an automatic one.
**Depends on:** F3
**Related to:** none
**Security notes:** Inbound email pipeline needs to validate sender/reject spam before processing. The forwarding address's unguessability is the actual access control — treat it like a credential (don't let it be easily enumerable, allow the user to regenerate it if it leaks).
**Technical stack notes:** Postmark or Mailgun inbound parsing on a dedicated subdomain, Claude API (vision + text extraction), Supabase Edge Function webhook. trip_items.trip_id needs to support a temporary null/unassigned state for the "Needs a trip" holding area — items land there first, get reassigned to a real trip_id once the user confirms.
**Open questions:** Whether to auto-suggest a likely trip when a forwarded email's extracted dates overlap an existing trip's date range, rather than always requiring manual assignment — nice-to-have, not essential to the base mechanism.

### F6 — Passport validity checker

**Status:** planned
**Priority:** nice-to-have
**Description:** Flags whether a traveler's passport(s) have enough remaining validity for a destination's rules — the "6 months" question only. Does not determine visa requirements — that's F7's job exclusively, see below for why this split exists.
**How it works:** Checks a reference table of destination validity rules against every passport the traveler holds (not just the primary one), and for multi-passport travelers, recommends which passport to travel on based on validity alone. Takes a destination and date range as input — in practice this comes from F3's "Check entry requirements" button, but the function itself doesn't require a real trip record to exist, just those two inputs, so it can be built and tested standalone before or independently of F3.
**Depends on:** F1
**Related to:** F3 (soft integration point — see F3's entry for the decoupling and fallback design), F7 (deliberately separate concern, not a build dependency — see below)
**Security notes:** Advisory only — must carry a "verify with the relevant embassy" disclaimer, never presented as guaranteed.
**Technical stack notes:** Supabase reference table (entry_requirements: country, min_passport_validity_months, verified, last_verified, notes — no visa field, see note below), seeded manually from IATA Travel Centre lookups — see tripvault-entry-requirements-starter.md.
**Open questions:** Data needs periodic re-verification since rules change.
**Design note — the F6/F7 split:** these two started out overlapping, because the original entry_requirements table carried a visa_required flag alongside the validity data — easy mistake, since IATA Travel Centre shows both facts side by side when you look a country up. That's been removed. F6 owns validity only, using a small, free, manually-verified dataset. F7 owns visa determination only, using a live paid API, because a static visa flag would go stale in exactly the way that causes real harm (unlike a validity rule, which barely changes). One feature, one question each — a v1 build genuinely won't answer "do I need a visa," only "is my passport valid enough," until F7 exists. That's an honest gap, not a compromise.

### F7 — Visa requirement checker

**Status:** future
**Priority:** future
**Description:** The sole owner of visa determination in this app — does a specific passport need a visa for a specific destination, and what kind. Not covered anywhere else, including F6.
**How it works:** Not yet built — would call a commercial visa-requirement API (e.g. RapidAPI Travel Buddy, Zylalabs) rather than a self-maintained dataset, given how often visa policy changes and how much more consequential a wrong answer is here than for the validity check in F6.
**Depends on:** F1
**Related to:** F6 (deliberately separate concern, not a build dependency — see F6's design note)
**Security notes:** Same advisory-only framing as F6, but higher liability given visa mistakes can mean denied boarding — needs stronger disclaimers and a link to the official source.
**Technical stack notes:** Third-party visa API, recurring per-lookup cost — needs its own pricing tier, not folded into base subscription cost.
**Open questions:** Which API to commit to; not worth deciding until there's a paying user base to justify the ongoing cost.

### F8 — Subscription tiers (Free / Pro / Family / Lifetime)

**Status:** planned
**Priority:** core
**Description:** Defines exactly what each tier unlocks, so gating decisions live in one place rather than being inferred from scattered notes on individual features.
**How it works:** Four tiers, each building on the one before:

| Tier | Price (illustrative) | Traveler profiles | Trips | Includes |
|---|---|---|---|---|
| **Free** | $0 | 1 | 1 active | F1 (document vault, including multiple passports for that one traveler), F2 (expiry reminders, full escalation, not reduced), F3 (trip folder, manual entry only), F4 (loyalty IDs) |
| **Pro** | $4.99/mo or $29.99/yr | 1 | Unlimited | Everything in Free, plus F5 (smart import — email/photo auto-extraction), F6 (passport validity checker) |
| **Family** | $49.99/yr | Up to 6 | Unlimited | Everything in Pro, plus multiple traveler profiles (this is what actually makes F3's multi-attendee checklist and F1/F4's per-traveler data meaningful beyond a single person), F9 (trip sharing, once built) |
| **Lifetime** | $99–120 one-time (see note) | 1 | Unlimited | Pro's feature set, subject to the same fair-use cap on F5 as any Pro subscriber — not Family's multi-traveler scope, to keep the one-time price defensible |

**On "lifetime," explicitly:**
- It means for as long as TripVault operates as a service, not an unconditional promise that outlives the business — this needs to be stated in exactly those terms in the ToS (see the new terms & conditions section below). Standard practice for lifetime-deal apps, not unusual or a bad-faith caveat to travelers who buy them.
- The price anchor matters more here than on any other tier: $79 against a $29.99/year Pro plan pays for itself in under 3 years, which is fine for a churny user base but risky if a meaningful share of buyers stay 5–10 years, given F5's ongoing per-use API cost and storage grows every year someone stays active. $99–120 (roughly 3–4x annual) is a more defensible long-run number. If $79 is used, it should be an explicit early-bird/launch price, not the permanent one.
- F5's usage cap (a reasonable monthly extraction limit, same fair-use logic as any Pro subscriber) applies to Lifetime buyers too, and matters more for them specifically — there's no recurring revenue offsetting a heavy user's ongoing cost the way there is on Pro-annual.

Two features are deliberately **not** slotted into this table:
- **F7 (visa checker)**, once built, carries a genuine recurring per-lookup cost that a flat subscription price doesn't account for — it needs its own metered add-on or pay-per-check pricing, not a place in Pro or Family, otherwise heavy users of that specific feature get subsidized by everyone else on the tier.
- **F10 (photo books)**, once built, is deliberately available regardless of tier — it's a one-off transactional purchase (pay per book, margin built into the print cost), not an ongoing feature worth gating behind a subscription at all.
**Depends on:** F1, F3, F11 (profile count limits per tier are enforced by F11, using the numbers defined here)
**Related to:** F5, F6, F7 (excluded, see above), F9, F10 (excluded, see above)
**Security notes:** Standard payment handling via RevenueCat/App Store/Play — no custom card storage needed.
**Technical stack notes:** RevenueCat SDK for gating the four tiers above; F7 and F10 need their own payment paths (see their own entries) since they fall outside this subscription structure entirely.
**Open questions:** None on the tier structure itself — but worth noting a gap surfaced while writing this out: an earlier draft of the plan mentioned "payment due date reminders" (for trip bookings, not documents) as a Pro-tier feature, and it never made it into this feature plan as its own numbered feature. Worth deciding whether that's still wanted, and if so, giving it an F-number of its own rather than assuming it's covered by F2 (which is document-expiry only).

### F9 — Family member access

**Status:** future
**Priority:** nice-to-have
**Description:** Gives a traveler profile (F11) who's a real person you organize trips for — a husband, a son — their own persistent, scoped login, so trips you add them to just appear for them automatically, without you re-sharing anything each time. A secondary, lighter one-off link stays available for a true outsider who isn't a traveler profile in the account at all.
**How it works:** The core scenario this is built for: one person organizes trips for family members who don't manage their own bookings, and those family members need to find their own trip's documents easily — including offline, at an airport, with no signal — without becoming co-organizers themselves. This is a genuinely different shape from a one-off share, so it gets a different mechanism:
*Primary mechanism — linked login, tied to an existing traveler profile.* From a traveler profile (e.g. "husband" or "son" in F11), the organizer sends a one-time invite ("Give [name] their own access"). The recipient sets up a simple login — once, ever, not per trip. From then on, whenever the organizer adds that traveler to a trip via F3's normal attendee selection, it automatically appears in the linked person's own view next time they open the app — no separate share step required per trip. They get read-only access to: the itinerary, the checklist, and every document attached to that trip, downloadable to their own phone so it's available offline once saved. Their own document (e.g. their own passport) is included too, since it's genuinely their own data. Strictly scoped to trips they're actually attending — never the organizer's other trips, never another traveler's documents. The organizer can revoke a linked person's access at any time from their profile in F11.
*Secondary mechanism — one-off link, for a true outsider.* Kept as a lighter option for someone who isn't a traveler profile in the account at all (a genuine one-time emergency contact) — same design as originally scoped: unguessable link, no account needed, read-only itinerary and checklist, documents excluded by default unless explicitly toggled on per share, revocable, trip-scoped only.
**Depends on:** F3, F11 (the linked-login mechanism directly extends a traveler profile, unlike the original link-only design)
**Related to:** F1 (documents are the actual payoff of the linked-login mechanism — being able to look up flight or transfer details on their own phone, including downloaded/offline), F8 (this is realistically a Family-tier feature, since it only makes sense once there's more than one traveler profile to link)
**Security notes:** A linked family member's account needs its own scoped authentication (not just a shared login) and its own row-level security: read-only, and limited to trips where their traveler_id appears in trip_travelers — never broader account access. The one-off link keeps its original security model: unguessable token as the access control, trip-scoped, view-only, rate-limited, optional auto-expiry.
**Technical stack notes:** travelers (F11) needs a nullable linked_auth_user_id once a family member accepts their invite. Supabase RLS policy for a linked user: read access to trips/trip_items/documents scoped to trip_travelers rows matching their own traveler_id, nothing else. Document downloads via signed URLs so they can be saved locally for offline access. The one-off link path keeps its own separate share_links table as previously scoped, unrelated to this auth mechanism.
**Open questions:** Whether a linked family member should also be able to check off checklist items (e.g. mark "picked up rental car" done) or stay strictly read-only — leaning read-only for v1 to keep this simple, but worth revisiting once it's actually in use.

### F10 — Trip photo books

**Status:** future
**Priority:** future
**Description:** Tag photos to a trip and order a printed photo book.
**How it works:** Not yet built — tagged photos sent to Peecho's Book Creator API to auto-generate a print-ready book; checkout via the app's own Stripe integration (not RevenueCat — physical goods can't go through platform IAP); pricing via a live quote (page count + destination) with a fixed margin on top, not a fixed price list.
Photo retention is staged, not indefinite and not immediate-delete either — both extremes are wrong here. Don't treat Peecho as an archive: it's a print fulfillment vendor, not a storage service, and there's no guarantee of indefinite self-serve retrieval from a past order, so deleting your only copy the moment an order is submitted risks losing the ability to ever reprint or fix a mistake. The staged approach: (1) while a book is being built, full-resolution tagged photos live in the app's own storage as normal; (2) once an order is placed, keep the full-resolution originals for a bounded window — 30–90 days — long enough to cover a realistic reorder-or-fix-a-typo period, then a scheduled job (same pattern as F2's daily reminder sweep) automatically purges them; (3) after that, keep only a small thumbnail (e.g. the cover) so the order still shows sensibly in order history, without paying to store the full source photos indefinitely. Give the user an explicit opt-in — "keep this photo book's photos so I can reorder later" — rather than making long-term full-resolution retention the silent default, so the common case (most people never reorder) stays cheap automatically and only those who actively want a permanent reorder option pay that storage cost.
**Depends on:** F3
**Related to:** none
**Security notes:** none identified beyond standard payment handling
**Technical stack notes:** Peecho Print API + Book Creator API, Stripe (separate from RevenueCat), original-resolution photo storage (new cost the rest of the app doesn't carry, mitigated by the retention policy above). Needs a scheduled Supabase Edge Function to sweep completed orders past the retention window and purge full-resolution originals, keeping only a thumbnail unless the user opted into permanent retention.
**Open questions:** Whether Peecho's photobook-specific API exposes the same Quote endpoint as parent company Prodigi's general API — needs checking at build time. Exact retention window (30 vs 90 days) not yet decided — worth setting based on real reorder-request data once the feature has usage.

### F11 — Traveler profile management

**Status:** planned
**Priority:** core
**Description:** Create and manage the traveler profiles every other feature attaches to — the people whose documents, bookings, and loyalty programs the app tracks. Foundational despite the late number: this logic was duplicated across F1, F3, F4 and F8 before being split out here — pulling it into one place is exactly the kind of change this whole feature-plan exercise exists to catch before it becomes a fragile build.
**How it works:** User adds a traveler profile with a name and a relationship to the account holder (self/partner/child/other). Selecting "child" (or any other minor-indicating value) flags the profile as a minor, which other features key off rather than reimplementing their own age logic — F1 uses this flag to require its parent/guardian acknowledgment before minor document entry and apply stricter data minimization to that profile; F8's tier limits (1 profile on Free/Pro, up to 6 on Family) are enforced here, checked against whichever tier the account currently holds.
**Depends on:** none — this is genuinely foundational, nothing else needs to exist first.
**Related to:** F1 (minor flag gates its acknowledgment flow), F3 (trip attendee selection reads from this list), F4 (loyalty programs are per-traveler), F8 (tier limits enforced here), F9 (extends a traveler profile with its own linked login — F9 depends on this feature, not the other way around)
**Security notes:** The is-minor flag is itself a sensitive signal about a real person — treat it with the same care as other profile data, and don't expose it unnecessarily to a linked family member (F9) beyond what their own scoped access already allows.
**Technical stack notes:** Supabase table: travelers (id, user_id, name, relationship, is_minor, created_at). Every feature currently referencing traveler_id builds against this table — F1's documents, F3's trip_travelers, F4's loyalty_programs.
**Open questions:** none

---

## Terms & conditions — drafting brief

This isn't drafted legal language — it's a running list of what the actual ToS needs to cover, pulled from decisions already made while building out the features above. Hand this to a lawyer for the real drafting; treat this section as the brief, not the document. Add to it as new features surface new terms implications, the same way the rest of this file grows.

**Subscriptions & billing (F8)**
- "Lifetime" access is explicitly scoped to "for as long as TripVault operates as a service" — not an unconditional forever-promise. State this plainly, don't bury it.
- Lifetime tier is subject to the same fair-use extraction limits on F5 as any Pro subscriber — worth disclosing this cap exists, even if the exact number isn't published.
- Standard subscription terms apply via the App Store / Play Store (auto-renewal, cancellation, refund policy) — mostly inherited from their platform terms, but the app's own ToS should still state the tier structure and what happens to data/access on downgrade or cancellation (e.g. what happens to a Family plan's extra traveler profiles if it lapses to Free).

**Advisory-only features, not guarantees (F6, F7)**
- Passport validity and visa requirement information is advisory only, sourced from third-party data that can change, and must not be relied on as a substitute for checking with the relevant embassy or consulate. This needs to be both a persistent in-app disclaimer wherever the checks are shown, and stated in the ToS as a limitation of liability.
- F7 (visa checker) specifically needs stronger liability language than F6 given the higher real-world consequence of a wrong answer (denied boarding vs. a validity-date miscalculation) — the ToS should reflect that this is informational only and the user remains responsible for verifying entry requirements independently.

**Sensitive document storage (F1)**
- Passport and ID data is the most sensitive category the app holds — the privacy policy needs to explicitly cover what's stored, how it's encrypted, who can access it, and how long it's retained after account deletion.
- **Children's data — this needs real legal review, not a generic clause, and the timing matters:**
  - *Australia (home jurisdiction, and this is live right now):* the OAIC's **Children's Online Privacy Code** must be registered by 10 December 2026, timed close to a realistic build/launch window. The exposure draft explicitly names **"family photo sharing applications"** as a captured example — a family travel-document app sits in the same category. Expected requirements: reasonable steps to determine whether an end user is a child, mandatory Privacy Impact Assessments for high-risk processing involving children's data (with a PIA kept on file), and an overarching "best interests of the child" design principle. Watch the OAIC's site for the final registered version rather than assuming the draft is final.
  - *United States (COPPA):* triggers not on being marketed to children, but on **actual knowledge** a user is under 13 — which a "child" relationship field on a traveler profile creates. Once triggered: verifiable parental consent, data minimization, a parent's right to review/delete the child's data, no ad-targeting built on it.
  - *EU (GDPR):* worth being precise rather than over-applying this — Article 8's specific child-consent age threshold is aimed at a child directly consenting to a service marketed to them, which is a different situation from a parent using a family tool to manage their own child's records (closer to a parent managing any of their child's records on their behalf). That distinction doesn't remove GDPR's general protections (data minimization, security, storage limits, right to erasure) from the child's data regardless of which basis applies.
  - *Product-level requirements this implies, regardless of which regime ends up strictest* (see F1's "How it works" for where this lives functionally): an explicit parent/guardian acknowledgment captured at the point a minor's document is entered, not buried in general signup; stricter data minimization on minor profiles specifically; a clearly separate, easy-to-find deletion path for a child's profile; a short written rationale for why children's passport data is stored and how it's protected, kept on file — effectively a lightweight PIA, which doubles as a head start on what Australia's Code will likely require formally.

**Email forwarding (F5)**
- The user's personal forwarding address is effectively a credential — the ToS/help content should tell users not to share it and that they're responsible for what gets sent to it, with the ability to regenerate it if it leaks.
- Standard email-abuse handling terms (what happens if the address is used to send spam/malicious content through the pipeline).

**Physical goods (F10)**
- Print and shipping timelines are outside the app's control once handed to the print partner — the ToS needs a clear disclaimer on production/shipping estimates (10+ business days for rest-of-world destinations, including Australia) rather than a guaranteed delivery date.
- Refund/reprint policy for damaged, lost, or misprinted books needs to be defined — likely inherited largely from the print partner's own policy, but the app's own terms should state what the customer should expect and who to contact.
- User is responsible for shipping address accuracy; standard "we're not liable for delivery failure due to an incorrect address" language applies.

**Family member access (F9, future)**
- Terms need to cover what a shared-link viewer can and can't do, and that the account owner is responsible for who they share a trip with — the app can scope access technically, but can't control what a recipient does with information they can see. Separately, a linked family member's own login (the primary F9 mechanism) needs its own terms acceptance — they're a genuine account holder in their own right, not just a recipient of a link.

**General**
- Standard "not a substitute for professional/legal/travel advice" disclaimer covering the app as a whole, not just F6/F7 specifically.
- Data export and deletion rights are now a real feature (F12) rather than a policy promise alone — the ToS should point to how a user actually exercises this, not just assert the right exists.

---

## Security & compliance review

No plan review can guarantee passing "any" compliance check — real compliance comes from documented controls and, for some standards, independent audit. What follows is a systematic gap-check against the standards most likely to actually apply, given what's already defined across the features above versus what isn't yet. Treat this like the terms & conditions section: a brief for a security/privacy professional before launch, not a replacement for one — especially given the data category here (government ID numbers, minors' data).

**Already covered elsewhere in this plan (pointers, not restated):** sensitive field encryption at rest (F1's document_number), access scoping/RLS per feature (F1, F9's both mechanisms, F5's unguessable forwarding address as a credential), advisory-only disclaimers on non-guaranteed information (F6, F7), children's data handling (F1's acknowledgment flow, the ToS section above), physical goods handling (F10), and staged retention for a specific high-cost data type (F10's photos).

**Gaps worth closing before launch:**

- **Encryption in transit** isn't explicitly stated anywhere — only "at rest" is mentioned for F1. Should be an explicit stated requirement (TLS everywhere) rather than an assumption riding on Supabase's defaults.
- **Authentication strength** — password requirements, an MFA/2FA option, and lockout after repeated failed login attempts aren't defined anywhere yet. Given what's being protected here is passport numbers, not just an email inbox, offering 2FA — and seriously considering requiring it for linked family accounts (F9) too — is worth building in from the start rather than retrofitting after launch.
- **Government-related identifiers — an Australia-specific point worth calling out explicitly, since it's core to what this app does.** Australian Privacy Principle 9 restricts an organization from adopting a government-related identifier (a passport number is one) as its own identifier for a person, and restricts its use or disclosure beyond specific purposes. Practically: never use a passport number as an internal database key or as the identifier tying records to a person — always use your own internal UUID, treating the passport number purely as a stored attribute. Worth explicitly confirming F1's schema is built this way.
- **Data breach / incident response plan** — not defined anywhere yet. Australia's Notifiable Data Breaches scheme and GDPR's 72-hour notification requirement both apply the moment there's an actual incident, and both need this plan to already exist beforehand, not get written after a breach happens.
- **Downloaded documents on a family member's device (F9)** — once a document is downloaded for offline access, it's no longer under the app's or Supabase's control at all — it's a file on someone's phone. Worth deciding whether downloaded files get their own app-level protection rather than relying entirely on the device's own security, given a lost or stolen phone would otherwise expose a plain passport scan sitting in local storage.
- **Third-party data processing agreements** — the plan already relies on several vendors handling sensitive data: Supabase (storage), Claude API (sees booking confirmation content during F5's extraction — no longer document images, now that F1's MRZ extraction runs on-device), Postmark/Mailgun (email content), RevenueCat/Stripe (payment), Peecho (photos). Under most privacy regimes, you remain responsible for how they handle it — each needs a reviewed data processing agreement, not just an assumption that a reputable vendor is automatically compliant.
- **PCI scope** — worth explicitly stating as a design principle rather than an accident: the app should never handle raw card numbers directly, routing all payment collection through RevenueCat/App Store/Play (F8) and Stripe's own hosted checkout (F10) — this keeps PCI-DSS scope minimal instead of requiring a full assessment.
- **Audit logging on sensitive data access** — not defined yet. Worth logging who accessed or modified a document record and when, both for your own security monitoring and because a compliance audit will likely ask for exactly this.
- **A concrete data export/deletion feature, not just a policy promise** — see F12 below, added directly as a result of this review.

### F12 — Data export and account deletion

**Status:** planned
**Priority:** core
**Description:** A real, buildable feature for exporting account data and permanently deleting an account — not just a ToS line — since privacy law in multiple jurisdictions gives individuals an enforceable right to both, with real response-time expectations a manual support process doesn't reliably meet.
**How it works:** From account settings, "Export my data" produces a downloadable package covering everything the account holds — traveler profiles (F11), documents (F1), trips and bookings (F3), loyalty programs (F4) — in a portable, readable format. "Delete my account" permanently removes all of it, cascading properly across every table this plan defines, not just a top-level user record. Subscription cancellation (F8) is a separate action from account deletion, and the interface should make that distinction clear rather than implying one does the other. A linked family member's own account (F9) is not deleted when the organizer's account is — that's a separate login with its own separate deletion path.
**Depends on:** F1, F3, F4, F11
**Related to:** F9 (linked accounts have their own separate deletion path), F8 (cancelling a subscription is distinct from deleting the account)
**Security notes:** Deletion must be a genuine hard delete of sensitive fields — not a soft "hidden" flag leaving the underlying data recoverable, given how sensitive this data category is. An export request should require re-authentication immediately beforehand, since it's effectively a full sensitive-data dump.
**Technical stack notes:** Needs a defined cascade-delete path across every table this plan has introduced (documents, trips, trip_items, trip_checklist_items, loyalty_programs, travelers, share_links). Worth a data-audit script confirming no orphaned sensitive records remain after a deletion, given how many tables now reference traveler_id.
**Open questions:** Exact response-time obligation varies by jurisdiction (GDPR expects action without undue delay, generally within a month; the Australian Privacy Act's "reasonable time" standard is less strictly defined) — worth confirming with legal review rather than assuming one global SLA covers every jurisdiction.
