# TripVault — test plan

Organized by feature, matching `tripvault-feature-plan.md`'s F-numbers. Each feature has functional tests (does it work), and where relevant, security tests (can it be misused or bypassed) and compliance tests (does it actually satisfy the obligation it exists for). Run security and compliance tests with real intent to break things, not just to confirm the happy path.

## F11 — Traveler profile management
**Functional**
- Create a profile with each relationship type (self/partner/child/other); confirm is_minor is set correctly only for "child."
- Confirm a Free/Pro account is blocked from creating a second profile; a Family account can create up to 6, and is blocked on a 7th.
**Security**
- Confirm user A cannot read or list user B's traveler profiles under any circumstance (direct API call, not just through the UI).

## F1 — Document vault
**Functional**
- Scan a real passport; confirm MRZ fields extract correctly and the checksum validation catches a deliberately corrupted/blurry scan rather than silently accepting bad data.
- Add a second passport to the same traveler (dual nationality); confirm both are stored and one can be marked primary.
- Attempt to add a document to a minor profile without completing the parent/guardian acknowledgment — confirm it's blocked until acknowledged.
- Manually edit an extracted field before saving; confirm the correction is what's actually stored, not the original extraction.
**Security**
- Confirm document_number is encrypted in the database, not stored in plaintext.
- Confirm a passport number is never used as a URL parameter, a database key, or a lookup identifier anywhere in the app (Australian Privacy Principle 9 — this is worth a deliberate code review, not just a functional test).
- Confirm user A cannot access user B's document files via a guessed or enumerated Storage URL.

## F2 — Expiry reminders
**Functional**
- Set a document's expiry to trigger each milestone (6/3/1 months) and confirm the correct channel combination fires at each — email only, then email+push, then email+push+banner.
- Confirm the in-app banner at the 1-month milestone actually persists across app opens until acknowledged, not just a one-time toast.
**Security/compliance**
- Confirm the email reminder cannot be fully disabled from settings, even though push can — this was a deliberate design decision, worth a test that verifies it holds.

## F4 — Loyalty program storage
**Functional**
- Add multiple programs to one traveler; confirm no accidental one-per-type constraint exists.
- Confirm no attempt is made to fetch or display an actual point balance — this is explicitly out of scope, worth confirming nothing was accidentally half-built here.

## F3 — Trip folder and checklist
**Functional**
- Create a trip with multiple attendees (Family tier); confirm the automatic passport-validity check runs on save and correctly flags an attendee whose passport won't clear the 6-month rule.
- Add each checklist item type; confirm auto-generated items (from F1's passport check) are visually distinguished from manual planning tasks as specified.
- Link a checklist item to a real trip_item and confirm it auto-marks done; confirm a manually-checked item also works.
- Press "Check entry requirements" before F6 is built (test this during Phase 5, before Phase 8) — confirm the fallback message shows, with no error and no crash.
- Re-run the same test after F6 is built (Phase 8 onward) — confirm the button now runs the real check instead of the fallback.
**Security**
- Confirm attendee selection only ever shows the account's own traveler profiles, never another account's.

## F8 — Subscription tiers
**Functional**
- Confirm each tier unlocks exactly what the feature plan's table specifies — no more, no less. Test the boundary explicitly: a Free account should be blocked from every Pro/Family feature, not just the obvious ones.
- Confirm F7 and F10, once built, are never gated by this tier system at all — test that a Free user can still access F10's photo book purchase flow, and that F7 requires its own separate payment path rather than any subscription tier.
- Test the Lifetime tier specifically: confirm it grants Pro's feature set, not Family's multi-traveler scope.
**Security**
- Attempt to access a Pro/Family-gated feature via a direct API call while on a Free account (not just through the UI, which might hide the option) — confirm the backend actually enforces the gate, not just the interface.

## F12 — Data export and account deletion
**Functional**
- Export data for an account with a non-trivial amount of data across all four source features (F1, F3, F4, F11); confirm the export is complete and readable.
- Delete an account; confirm every table listed in the schema is actually cleared — this is explicitly the test the feature plan calls out as necessary, run a direct database check afterward, not just a UI check that the account "looks" gone.
- Confirm a linked family member's account (F9) survives the organizer's account deletion, and has its own separate deletion path.
- Confirm subscription cancellation and account deletion are distinct actions — deleting the account shouldn't silently forget to cancel a live subscription, and cancelling a subscription shouldn't delete the account.
**Security/compliance**
- Confirm an export request requires fresh re-authentication immediately before generating the package.
- Confirm deletion is a genuine hard delete — check the database directly for the sensitive fields (document_number especially) after deletion, not just that the record is hidden from the UI.

## F6 — Passport validity checker
**Functional**
- Test a traveler with two passports against a destination where one clears validity and the other doesn't; confirm the recommendation correctly identifies which one to travel on.
- Confirm the advisory disclaimer is shown every time a check result displays, not just the first time.
- Test against an unverified row in entry_requirements (per the starter dataset's verified flag) — confirm the app doesn't silently treat unverified data as equivalent to verified data.
**Compliance**
- Confirm no visa-related determination is made anywhere in this feature — it should only ever answer the validity question, per the deliberate F6/F7 split.

## F5 — Email and photo auto-extraction
**Functional**
- Photo path: scan a real booking confirmation; confirm extracted fields are correct and editable before saving.
- Email path: forward a real confirmation email to the personal forwarding address; confirm it arrives in the "Needs a trip" holding area, and can be manually assigned to the correct trip.
- Test an email forwarded when no trip exists yet at all — confirm it still lands safely in the holding area rather than being lost or erroring.
**Security**
- Confirm the personal forwarding address is genuinely unguessable (not a predictable pattern like the account's own email with a suffix).
- Send a test email to a different user's forwarding address's near-miss (one character off) and confirm nothing is created — the address itself is the security boundary and needs to fail closed on any mismatch.

## F9 — Family member access
**Functional**
- Set up a linked family member account for a traveler profile; add them to a new trip via normal F3 attendee selection; confirm it appears automatically in their view without any separate share step.
- Confirm they can download a document for offline access, and that it's still viewable with the device in airplane mode afterward.
- Test the secondary one-off link mechanism separately: generate a link, open it with no account, confirm read-only itinerary/checklist access with documents excluded by default.
- Revoke a linked family member's access; confirm they immediately lose access on next attempt.
**Security**
- Confirm a linked family member can see only trips where their own traveler_id is in trip_travelers — never another trip on the organizer's account, even one they're not attending.
- Confirm a linked family member's access is genuinely read-only — attempt to edit or delete something via a direct API call, not just check that the UI hides the option.
- Confirm the one-off link is rate-limited against brute-force token guessing.
- Confirm a leaked one-off link only ever exposes its one trip, never the organizer's account generally.

## F7 — Visa requirement checker (once built)
- Full test plan to be written once the API provider is chosen — flag as an open item in `tripvault-setup-steps.md`, not forgotten.

## F10 — Trip photo books (once built)
- Full test plan to be written once built, but at minimum: confirm the staged retention policy actually purges full-resolution photos after the chosen window unless the user opted into permanent retention, and confirm the payment path uses Stripe directly, never RevenueCat.

## Cross-cutting checks (run once most features exist)
- Confirm every place a subscription tier gates a feature is enforced server-side, not just client-side, by attempting each gated action via a direct API call on a Free account.
- Confirm no feature anywhere uses a passport number, email address, or other personal identifier as a URL parameter or as part of a shareable link.
- Run through the full account lifecycle once: sign up → add a minor traveler → add documents → create a trip with multiple attendees → subscribe to Family → invite a linked family member → export data → delete the account. This end-to-end pass tends to surface integration gaps that per-feature testing misses.
