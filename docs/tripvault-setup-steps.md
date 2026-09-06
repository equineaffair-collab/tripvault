# TripVault — setup steps guide

Things Claude Code can't do for you — accounts, credentials, and decisions that need to exist before or during the phase that needs them. Organized in the order you'll actually hit them, matching the phases in `tripvault-claude-code-prompts.md`.

## Status, 2026-09-06

Phases 0-10 are built. Everything below that is still unticked is genuinely
waiting on you; nothing else is. `HISTORY.md` has the reasoning for each.

## Before Phase 0
- [x] Create a Supabase project — get the URL, anon key, and service role key.
      *(Done. The service role key was fetched from the authenticated CLI on
      2026-09-06 and is in `scripts/.service-key`, gitignored.)*
- [ ] Get an Anthropic API key — **now only needed for F5's booking extraction.**
      F1's document extraction moved on-device on 2026-09-05 and needs no key.
      Set it with `supabase secrets set ANTHROPIC_API_KEY=...`; until then
      forwarded mail is stored and left unread rather than lost.
- [ ] Register a domain if you don't have one yet (needed later for the email subdomain in Phase 3/9).
- [x] Create an empty GitHub repository. *(Done: equineaffair-collab/tripvault.)*

## Before Phase 3 (F2 — reminders)
- [ ] Create a Postmark or Mailgun account. Set up a subdomain (e.g. `trips.tripvaultapp.com`) for both outbound transactional email now and inbound parsing later (Phase 9) — one vendor, one piece of DNS setup, covers both.

## Before Phase 6 (F8 — subscriptions)
- [ ] Apple Developer account (for App Store distribution and in-app purchases).
- [ ] Google Play Developer account (same, for Android).
- [ ] Create a RevenueCat account, and set up the four products matching the feature plan's tier table: Pro monthly, Pro yearly, Family yearly, Lifetime (one-time, non-consumable). Confirm the actual prices before creating these — the feature plan's figures are illustrative, not final (particularly the Lifetime price — see the feature plan's note on why $79 vs $99–120 matters).
- [x] EAS Build set up for dev and production builds. *(Done 2026-09-05. Project
      `@blackbirdzz-property/tripvault`; the Android keystore was generated in
      the cloud and lives in the Expo account — losing it means being unable to
      ship Play updates. Retrieve it with `eas credentials`.)*

## Before Phase 7 (F12 — data export/deletion)
- [ ] Decide the exact response-time commitment for export/deletion requests, ideally with legal input — this varies by jurisdiction and the feature plan flags it as unresolved.

## Before Phase 8 (F6 — passport validity checker)
- [ ] Work through `tripvault-entry-requirements-starter.md` — the manual IATA Travel Centre lookups for the ~25 starter destinations, for both an Australian and (if you want the dual-passport comparison to actually work) a Latvian/EU passport. This is genuinely manual research, not something to hand to Claude Code.

## Before Phase 9 (F5 — email/photo extraction)
- [ ] Confirm the Postmark/Mailgun inbound-parsing DNS records are live (should already exist from Phase 3's setup).
- [ ] A **custom domain for Edge Functions**, if the share link should open as a
      styled page. Supabase rewrites an HTML Content-Type to `text/plain` on the
      default functions domain (anti-phishing), so a share link currently
      renders as formatted plain text — which works for everyone and needs
      nothing. Behind a custom domain, set `SHARE_PAGE_FORMAT=html`.
- [ ] Point inbound parsing at the `inbound-email` Edge Function and set
      `INBOUND_EMAIL_DOMAIN` to the receiving subdomain. The function is
      deployed and verified; it authenticates the provider with the secret in
      `scripts/.inbound-secret`, passed either as `?secret=<value>` on the
      webhook URL or as an `x-tripvault-secret` header. Mailgun signs its own
      webhooks — set `MAILGUN_WEBHOOK_SIGNING_KEY` instead and the HMAC path is
      used. **The domain is deliberately unset**, so the app currently tells the
      user mail cannot arrive yet rather than showing an address that looks like
      it works.

## Before Phase 10 (F9 — family member access)
- [ ] Decide whether linked family accounts require MFA (the feature plan's security review raises this as worth considering, given the sensitivity of what they can access).
      **Built without it**, on the assumption that a v1 linked account is
      email+password like any other. Worth revisiting: a linked account reads
      passport scans, and it is the account most likely to belong to someone who
      is not thinking about security at all.
- [ ] Decide whether a **child** profile should ever get its own login. Built
      refusing it, which is my call rather than the feature plan's — see
      HISTORY.md for the reasoning. Reversing it means deleting one check in
      `supabase/migrations/0010_family_access.sql`.
- [ ] Decide whether a linked member should be able to tick off checklist items.
      The feature plan leans read-only for v1 and that is what is built —
      structurally, with no write policy at all rather than a hidden button.

## Development settings to revert before launch

Things switched off to make building possible, each of which is a real hole
until it goes back. Re-check this list before any build reaches a real user.

- [ ] **Re-enable email confirmation.** Turned OFF on 2026-09-05 so the
  verification scripts could sign throwaway accounts straight in. While it is
  off, anyone can register under an address they do not own. That matters more
  here than in most apps: F5 later treats a per-user forwarding address as a
  credential, and an unverified account holder would be handed one.
  Authentication -> Sign In / Providers -> Confirm email, in the Supabase
  dashboard. Confirm it took by checking `mailer_autoconfirm` reads `false`:
  `curl -s -H "apikey: <publishable key>" https://<ref>.supabase.co/auth/v1/settings`
  Do this alongside Phase 3's Postmark/Mailgun setup, since you will want your
  own SMTP by then anyway -- Supabase's built-in sender is rate-limited to a
  handful of messages an hour and will throttle real signups.

## Dependencies waiting on your approval

The project convention is to ask before adding a third-party dependency. These
four are wanted by features that are otherwise built, and each one has a stated
fallback that is currently in use:

- [ ] `expo-notifications` — F2's push channel. The column and the send path
      exist; the sweep delivers the moment a device token is stored. Without it,
      reminders are email-only, and email has no provider yet either.
- [ ] `expo-file-system` and `expo-sharing` — F12's export currently renders the
      package as selectable JSON on screen. That works and is not what anyone
      wants from a data-portability feature.
- [ ] `@expo/vector-icons` — the tab bar is label-only. Cosmetic.
- [ ] `expo-clipboard` — there is no copy button anywhere. The F9 invite code
      and share URL are selectable text, which on Android means a long press and
      a drag, and both screens say "copy it now" before making that awkward.

## Before launch, regardless of phase
- [ ] **Legal review of the terms & conditions and security & compliance sections** in `tripvault-feature-plan.md` — treat both as a drafting brief for an actual lawyer, not final text. Flag two things specifically when you do this: the Australian Children's Online Privacy Code (must register by 10 December 2026, and the exposure draft names "family photo sharing applications" as an example of what it covers), and Australian Privacy Principle 9's restriction on using a passport number as an identifier.
- [ ] Data processing agreements reviewed for every vendor handling sensitive data: Supabase, Anthropic, Postmark/Mailgun, RevenueCat, Stripe, and Peecho once F10 is built.
- [ ] Write an actual data breach / incident response plan — who does what, who gets notified, within what timeframe — before you need it, not after.
- [ ] App Store and Play Store privacy disclosures (Apple's App Privacy details, Google's Data Safety section) need to accurately reflect that the app stores government ID data — this is a real declaration, not boilerplate, given what F1 stores.
- [ ] Set up error monitoring (e.g. Sentry) — not covered in the feature plan directly, but standard practice before real users hit the app.

## Deferred decisions (not needed until F7/F10 are actually greenlit)
- [ ] Which visa-requirement API to commit to for F7 (RapidAPI Travel Buddy vs. Zylalabs) — the feature plan deliberately leaves this open until there's a paying user base to justify the ongoing cost.
- [ ] Exact photo retention window for F10 (30 vs. 90 days) — deliberately left open pending real usage data.
