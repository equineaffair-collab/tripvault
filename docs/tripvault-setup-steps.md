# TripVault — setup steps guide

Things Claude Code can't do for you — accounts, credentials, and decisions that need to exist before or during the phase that needs them. Organized in the order you'll actually hit them, matching the phases in `tripvault-claude-code-prompts.md`.

## Before Phase 0
- [ ] Create a Supabase project — get the URL, anon key, and service role key.
- [ ] Get an Anthropic API key for the Claude API calls (F1's document extraction, F5's booking extraction).
- [ ] Register a domain if you don't have one yet (needed later for the email subdomain in Phase 3/9).
- [ ] Create an empty GitHub repository (no README/.gitignore — Claude Code will scaffold those) and have the repo URL ready to hand to Claude Code, so it can connect and push the initial commit as part of Phase 0.

## Before Phase 3 (F2 — reminders)
- [ ] Create a Postmark or Mailgun account. Set up a subdomain (e.g. `trips.tripvaultapp.com`) for both outbound transactional email now and inbound parsing later (Phase 9) — one vendor, one piece of DNS setup, covers both.

## Before Phase 6 (F8 — subscriptions)
- [ ] Apple Developer account (for App Store distribution and in-app purchases).
- [ ] Google Play Developer account (same, for Android).
- [ ] Create a RevenueCat account, and set up the four products matching the feature plan's tier table: Pro monthly, Pro yearly, Family yearly, Lifetime (one-time, non-consumable). Confirm the actual prices before creating these — the feature plan's figures are illustrative, not final (particularly the Lifetime price — see the feature plan's note on why $79 vs $99–120 matters).
- [ ] EAS Build set up for creating dev and production builds (needed regardless of subscriptions, since the document scanner plugin from Phase 2 already requires a dev build — worth doing this earlier if Phase 2 is blocked without it).

## Before Phase 7 (F12 — data export/deletion)
- [ ] Decide the exact response-time commitment for export/deletion requests, ideally with legal input — this varies by jurisdiction and the feature plan flags it as unresolved.

## Before Phase 8 (F6 — passport validity checker)
- [ ] Work through `tripvault-entry-requirements-starter.md` — the manual IATA Travel Centre lookups for the ~25 starter destinations, for both an Australian and (if you want the dual-passport comparison to actually work) a Latvian/EU passport. This is genuinely manual research, not something to hand to Claude Code.

## Before Phase 9 (F5 — email/photo extraction)
- [ ] Confirm the Postmark/Mailgun inbound-parsing DNS records are live (should already exist from Phase 3's setup).

## Before Phase 10 (F9 — family member access)
- [ ] Decide whether linked family accounts require MFA (the feature plan's security review raises this as worth considering, given the sensitivity of what they can access).

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

## Before launch, regardless of phase
- [ ] **Legal review of the terms & conditions and security & compliance sections** in `tripvault-feature-plan.md` — treat both as a drafting brief for an actual lawyer, not final text. Flag two things specifically when you do this: the Australian Children's Online Privacy Code (must register by 10 December 2026, and the exposure draft names "family photo sharing applications" as an example of what it covers), and Australian Privacy Principle 9's restriction on using a passport number as an identifier.
- [ ] Data processing agreements reviewed for every vendor handling sensitive data: Supabase, Anthropic, Postmark/Mailgun, RevenueCat, Stripe, and Peecho once F10 is built.
- [ ] Write an actual data breach / incident response plan — who does what, who gets notified, within what timeframe — before you need it, not after.
- [ ] App Store and Play Store privacy disclosures (Apple's App Privacy details, Google's Data Safety section) need to accurately reflect that the app stores government ID data — this is a real declaration, not boilerplate, given what F1 stores.
- [ ] Set up error monitoring (e.g. Sentry) — not covered in the feature plan directly, but standard practice before real users hit the app.

## Deferred decisions (not needed until F7/F10 are actually greenlit)
- [ ] Which visa-requirement API to commit to for F7 (RapidAPI Travel Buddy vs. Zylalabs) — the feature plan deliberately leaves this open until there's a paying user base to justify the ongoing cost.
- [ ] Exact photo retention window for F10 (30 vs. 90 days) — deliberately left open pending real usage data.
