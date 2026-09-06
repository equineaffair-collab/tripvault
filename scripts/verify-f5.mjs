/**
 * F5 verification — smart import, live.
 *
 *   node scripts/verify-f5.mjs
 *
 * The interesting half is Path B, and it can be verified in full without an
 * email provider: the webhook is an HTTP endpoint, so this posts realistic
 * Postmark payloads at it and checks what lands.
 *
 * Extraction is verified too, and no API key is configured on this project —
 * that is the point. One payload carries the schema.org markup a real airline
 * confirmation ships and must be read exactly; one is plain text and must be
 * read but flagged as a guess; one is a marketing email from the same airline
 * and must produce nothing at all.
 *
 * Requires the service role key (scripts/.service-key) to grant a Pro tier, and
 * scripts/.inbound-secret to sign webhook calls. Requires "Confirm email" OFF.
 */
import { createClient } from '@supabase/supabase-js';
import { existsSync, readFileSync } from 'node:fs';
import { grantTier, hasServiceKey, serviceKey } from './_tier.mjs';
import { suggestTrip, holdingAreaSummary } from '../lib/smartImportFormat.ts';

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => l.trim() && !l.trim().startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    })
);

const URL_BASE = env.EXPO_PUBLIC_SUPABASE_URL;
const SECRET_FILE = new URL('./.inbound-secret', import.meta.url);
const inboundSecret = existsSync(SECRET_FILE) ? readFileSync(SECRET_FILE, 'utf8').trim() : '';

const client = () =>
  createClient(URL_BASE, env.EXPO_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });

let pass = 0;
let fail = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  ok ? pass++ : fail++;
};

console.log('\nF5 — smart import\n');

if (!hasServiceKey) {
  console.log('  SKIP  needs a Pro tier, which only the service role can grant.');
  console.log('        Put the key in scripts/.service-key and re-run.\n');
  process.exit(0);
}
if (!inboundSecret) {
  console.log('  SKIP  scripts/.inbound-secret is missing, so the webhook cannot be called.\n');
  process.exit(0);
}

const admin = createClient(URL_BASE, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const stamp = Date.now();

async function signUpAndIn(c, creds) {
  const { error: upErr } = await c.auth.signUp(creds);
  if (upErr && !/already registered/i.test(upErr.message)) throw new Error(upErr.message);
  const { data, error } = await c.auth.signInWithPassword(creds);
  if (error) {
    throw new Error(
      `${error.message}\n\n  If this says "Email not confirmed", turn OFF Auth > Sign In / ` +
        `Providers > "Confirm email" and re-run.`
    );
  }
  return data.user;
}

async function fn(c, name, body) {
  const { data, error } = await c.functions.invoke(name, { body });
  if (!error) return { data, error: null, status: 200 };
  const res = error.context;
  const payload = res && typeof res.json === 'function' ? await res.json().catch(() => null) : null;
  return { data: null, error: payload ?? { error: error.message }, status: res?.status ?? 0 };
}

/** A Postmark inbound payload, as the provider would post it. */
const postmarkPayload = (to, over = {}) => ({
  OriginalRecipient: to,
  From: 'bookings@example-airline.test',
  Subject: `Your booking is confirmed ${stamp}`,
  TextBody:
    'Thanks for booking with us.\n\nBooking reference: ZZ9ABC\n' +
    'Departing 14 March 2027 at 09:20 from Sydney.\n\nSee you on board.',
  ...over,
});

const postWebhook = (payload, secret = inboundSecret) =>
  fetch(`${URL_BASE}/functions/v1/inbound-email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-tripvault-secret': secret },
    body: JSON.stringify(payload),
  }).then(async (r) => ({ status: r.status, body: await r.text() }));

const user = client();
const uUser = await signUpAndIn(user, {
  email: `tv-f5-${stamp}@tripvault.local`,
  password: 'Test-passw0rd!F5',
});

console.log('Smart import is gated, and the gate is in the database');
{
  const r = await fn(user, 'smart-import', { action: 'address' });
  check('a Free account gets no forwarding address', Boolean(r.error), r.error?.error ?? 'issued!');
  check('and is told which tier includes it', /pro/i.test(r.error?.error ?? ''), r.error?.error ?? '');

  // The test plan's shape for every gated feature: attack it by direct API
  // call, not through the interface.
  const { error: insErr } = await user.from('trip_items').insert({
    user_id: uUser.id,
    type: 'flight',
    source: 'email',
    provider: 'Forged Airlines',
  });
  check('an "email" booking cannot be inserted on Free', Boolean(insErr), insErr?.code ?? 'accepted!');

  // Manual entry is free on every plan. Gating it would be gating the app.
  const { error: manualErr } = await user.from('trip_items').insert({
    user_id: uUser.id,
    type: 'flight',
    source: 'manual',
    provider: `F5 manual ${stamp}`,
  });
  check('a manual booking is still allowed on Free', !manualErr, manualErr?.message ?? '');
  await user.from('trip_items').delete().eq('user_id', uUser.id);
}

await grantTier(URL_BASE, uUser.id, 'pro');

console.log('\nThe forwarding address');
let localPart = null;
{
  const r = await fn(user, 'smart-import', { action: 'address' });
  localPart = r.data?.localPart ?? null;
  check('a Pro account is issued one', Boolean(localPart), r.error?.error ?? '');
  check(
    'with real entropy rather than anything guessable',
    /^tv[a-z2-7]{24}$/.test(String(localPart)),
    String(localPart)
  );
  check(
    'and it does not contain the account’s email or id',
    !String(localPart).includes(uUser.id.slice(0, 8)) && !String(localPart).includes('tv-f5'),
    String(localPart)
  );

  const again = await fn(user, 'smart-import', { action: 'address' });
  check('asking twice returns the same address', again.data?.localPart === localPart, again.data?.localPart ?? '');

  // No inbound domain is configured on this project yet, and the function says
  // so rather than handing back an address that cannot receive anything.
  check('it reports honestly that mail cannot arrive yet', r.data?.configured === false, String(r.data?.configured));
}

console.log('\nAn address is a credential, and is treated like one');
{
  const stranger = client();
  const sUser = await signUpAndIn(stranger, {
    email: `tv-f5-x-${stamp}@tripvault.local`,
    password: 'Test-passw0rd!X',
  });

  const { data: peek } = await stranger.from('forwarding_addresses').select('local_part');
  check(
    'another account cannot enumerate addresses',
    (peek ?? []).length === 0,
    `${peek?.length} rows`
  );

  const { error: writeErr } = await stranger
    .from('forwarding_addresses')
    .insert({ user_id: sUser.id, local_part: 'tv' + 'a'.repeat(24) });
  check('nor choose its own', Boolean(writeErr), writeErr?.code ?? 'accepted!');

  await admin.auth.admin.deleteUser(sUser.id).catch(() => {});
}

console.log('\nThe webhook refuses anything it cannot verify');
{
  const noSecret = await fetch(`${URL_BASE}/functions/v1/inbound-email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(postmarkPayload(`${localPart}@trips.test`)),
  }).then((r) => r.status);
  check('an unsigned request is rejected', noSecret === 401, `HTTP ${noSecret}`);

  const wrong = await postWebhook(postmarkPayload(`${localPart}@trips.test`), 'not-the-secret');
  check('a wrong secret is rejected', wrong.status === 401, `HTTP ${wrong.status}`);

  const { count } = await user
    .from('inbound_emails')
    .select('id', { count: 'exact', head: true });
  check('and nothing was recorded either time', count === 0, `${count}`);
}

console.log('\nMail for an address nobody has is dropped, not stored');
{
  // Counted across ALL users with the service role, before and after. The
  // claim is that no row is written anywhere; an owner-scoped count would pass
  // whether that were true or not, since there is no owner either way.
  const { count: before } = await admin
    .from('inbound_emails')
    .select('id', { count: 'exact', head: true });

  const r = await postWebhook(postmarkPayload('tv' + 'z'.repeat(24) + '@trips.test'));
  // 200, so the provider stops retrying: this was handled, not failed.
  check('the provider is told it was handled', r.status === 200, `HTTP ${r.status}`);
  check('and told nothing matched', /"matched":false/.test(r.body), r.body.slice(0, 80));

  const { count: after } = await admin
    .from('inbound_emails')
    .select('id', { count: 'exact', head: true });
  check(
    'no row was written anywhere — there is no user to own one',
    after === before,
    `${before} -> ${after}`
  );
}

console.log('\nA forwarded booking arrives and is kept');
{
  const r = await postWebhook(postmarkPayload(`${localPart}@trips.test`));
  check('the webhook accepts it', r.status === 200, `HTTP ${r.status}`);

  const { data: mail } = await user
    .from('inbound_emails')
    .select('id, subject, from_address, status, detail, body_text, trip_item_id');

  check('exactly one message was recorded', (mail ?? []).length === 1, `${mail?.length}`);
  check('with its subject', mail?.[0]?.subject?.includes(String(stamp)), mail?.[0]?.subject ?? '');
  check('and its sender', mail?.[0]?.from_address?.includes('example-airline'), mail?.[0]?.from_address ?? '');

  // Rewritten 2026-09-07. This used to assert the message was left 'pending'
  // because no API key was configured. Extraction no longer needs one, so the
  // honest assertion is that it was read on arrival.
  check(
    'it is read on arrival, not parked',
    mail?.[0]?.status === 'extracted',
    `${mail?.[0]?.status} — ${mail?.[0]?.detail}`
  );
  check(
    'the body is kept, so a message can be re-read later',
    Boolean(mail?.[0]?.body_text),
    `${mail?.[0]?.body_text?.length ?? 0} chars`
  );
  check('and it became a booking', Boolean(mail?.[0]?.trip_item_id), 'no item');

  await user.from('trip_items').delete().eq('user_id', uUser.id);
}

console.log("\nA forwarded booking is READ, with no API key configured");
{
  // The whole point of the 2026-09-07 rewrite. Before it, this message would
  // have been stored and left unread until somebody bought an API key. The
  // markup below is Google's email schema, which is what real airline
  // confirmations carry.
  const flightMarkup = {
    '@context': 'http://schema.org',
    '@type': 'FlightReservation',
    reservationNumber: `MK${stamp % 10000}`,
    reservationFor: {
      '@type': 'Flight',
      flightNumber: '1',
      airline: { '@type': 'Airline', name: 'Verified Air', iataCode: 'VA' },
      departureAirport: { '@type': 'Airport', iataCode: 'SYD' },
      arrivalAirport: { '@type': 'Airport', iataCode: 'LHR' },
      departureTime: '2027-03-14T09:20:00+11:00',
    },
  };

  const r = await postWebhook(
    postmarkPayload(`${localPart}@trips.test`, {
      Subject: `Markup booking ${stamp}`,
      HtmlBody:
        `<html><body><p>Your booking is confirmed.</p><script type="application/ld+json">` +
        `${JSON.stringify(flightMarkup)}</script></body></html>`,
    })
  );
  check('the webhook accepts it', r.status === 200, `HTTP ${r.status}`);

  const { data: mail } = await user
    .from('inbound_emails')
    .select('status, detail, trip_item_id')
    .order('received_at', { ascending: false })
    .limit(1);

  check(
    'and it is EXTRACTED, not left waiting for a provider',
    mail?.[0]?.status === 'extracted',
    `${mail?.[0]?.status} — ${mail?.[0]?.detail}`
  );
  check(
    'the receipt says it was read from the booking data, not guessed',
    /json-ld/.test(mail?.[0]?.detail ?? ''),
    mail?.[0]?.detail ?? ''
  );

  const { data: item } = await user
    .from('trip_items')
    .select('id, type, provider, confirmation_number, item_date, source, notes, trip_id')
    .eq('id', mail?.[0]?.trip_item_id ?? '')
    .maybeSingle();

  check('a booking was created', Boolean(item), 'none');
  check('with the right type', item?.type === 'flight', item?.type ?? '');
  check('the airline, not the sender', item?.provider === 'Verified Air', item?.provider ?? '');
  check(
    'the booking reference',
    item?.confirmation_number === `MK${stamp % 10000}`,
    item?.confirmation_number ?? ''
  );
  // +11:00 on the 14th at 09:20 is 22:20 UTC on the 13th. Getting this wrong
  // moves a flight by a day, in the direction that makes someone miss it.
  check(
    'and the departure time with its timezone applied',
    String(item?.item_date).startsWith('2027-03-13T22:20'),
    String(item?.item_date)
  );
  check('the flight number and route are noted', /VA1/.test(item?.notes ?? ''), item?.notes ?? '');
  check('it lands in the holding area, not a trip', item?.trip_id === null, String(item?.trip_id));

  await user.from('trip_items').delete().eq('id', item?.id ?? '');
}

console.log("\nA plain-text confirmation is read too, and says it was a guess");
{
  const r = await postWebhook(
    postmarkPayload(`${localPart}@trips.test`, { Subject: `Plain booking ${stamp}` })
  );
  check('the webhook accepts it', r.status === 200, `HTTP ${r.status}`);

  const { data: mail } = await user
    .from('inbound_emails')
    .select('status, detail, trip_item_id')
    .order('received_at', { ascending: false })
    .limit(1);

  check('it is extracted', mail?.[0]?.status === 'extracted', `${mail?.[0]?.status}`);
  check(
    'and flagged as read from the wording, so the user checks it',
    /worth checking/.test(mail?.[0]?.detail ?? ''),
    mail?.[0]?.detail ?? ''
  );

  const { data: item } = await user
    .from('trip_items')
    .select('id, confirmation_number, item_date')
    .eq('id', mail?.[0]?.trip_item_id ?? '')
    .maybeSingle();

  check('the reference was found', item?.confirmation_number === 'ZZ9ABC', item?.confirmation_number ?? '');
  check('and the date', String(item?.item_date).startsWith('2027-03-14'), String(item?.item_date));

  await user.from('trip_items').delete().eq('id', item?.id ?? '');
}

console.log("\nA marketing email produces nothing at all");
{
  const r = await postWebhook(
    postmarkPayload(`${localPart}@trips.test`, {
      Subject: `Sale ${stamp}`,
      TextBody: 'Summer sale! Save 30% on beach holidays this year. Unsubscribe here.',
    })
  );
  check('the webhook accepts it', r.status === 200, `HTTP ${r.status}`);

  const { data: mail } = await user
    .from('inbound_emails')
    .select('status, trip_item_id')
    .order('received_at', { ascending: false })
    .limit(1);

  // An empty booking somebody then has to find and delete is worse than a
  // message that says plainly it was not a booking.
  check('it is marked unreadable', mail?.[0]?.status === 'unreadable', `${mail?.[0]?.status}`);
  check('and no booking was invented', mail?.[0]?.trip_item_id === null, String(mail?.[0]?.trip_item_id));
}

console.log('\nThe user owns what arrived');
{
  const stranger = client();
  const sUser = await signUpAndIn(stranger, {
    email: `tv-f5-y-${stamp}@tripvault.local`,
    password: 'Test-passw0rd!Y',
  });
  const { data: peek } = await stranger.from('inbound_emails').select('id');
  check("another account cannot read someone's mail", (peek ?? []).length === 0, `${peek?.length}`);

  const { error: forgeErr } = await stranger
    .from('inbound_emails')
    .insert({ user_id: sUser.id, subject: 'forged' });
  check('nor fabricate a message that arrived', Boolean(forgeErr), forgeErr?.code ?? 'accepted!');
  await admin.auth.admin.deleteUser(sUser.id).catch(() => {});

  const { data: mine } = await user.from('inbound_emails').select('id');
  const before = mine.length;
  const { error: delErr } = await user.from('inbound_emails').delete().eq('id', mine[0].id);
  // Deleting is how someone clears stored mail content they would rather not
  // have kept. It has to work.
  check('but the owner can delete it', !delErr, delErr?.message ?? '');

  const { count } = await user.from('inbound_emails').select('id', { count: 'exact', head: true });
  check('and that message is genuinely gone', count === before - 1, `${before} -> ${count}`);
}

console.log('\nThe holding area');
{
  // What extraction would produce, written directly, so the rest of the path is
  // exercised even though no extraction provider is configured.
  const { data: held, error: heldErr } = await user
    .from('trip_items')
    .insert({
      user_id: uUser.id,
      trip_id: null,
      type: 'flight',
      provider: `F5 Airways ${stamp}`,
      confirmation_number: 'ZZ9ABC',
      source: 'email',
      item_date: '2027-03-14T09:20:00Z',
    })
    .select('id')
    .single();
  check('an extracted booking lands with no trip', !heldErr && Boolean(held), heldErr?.message ?? '');

  const { data: unassigned } = await user
    .from('trip_items')
    .select('id, trip_id')
    .is('trip_id', null);
  check('and shows up in the holding area', unassigned?.length === 1, holdingAreaSummary(unassigned?.length ?? 0));

  const { data: trip } = await user
    .from('trips')
    .insert({ user_id: uUser.id, name: `F5 Japan ${stamp}`, start_date: '2027-03-01', end_date: '2027-03-20' })
    .select('id, name, start_date, end_date')
    .single();

  const { data: other } = await user
    .from('trips')
    .insert({ user_id: uUser.id, name: `F5 Bali ${stamp}`, start_date: '2027-07-01', end_date: '2027-07-14' })
    .select('id, name, start_date, end_date')
    .single();

  const windows = [trip, other].map((t) => ({
    id: t.id,
    name: t.name,
    startDate: t.start_date,
    endDate: t.end_date,
  }));

  const suggestion = suggestTrip('2027-03-14T09:20:00Z', windows);
  check('the right trip is suggested by date', suggestion?.tripId === trip.id, suggestion?.tripName ?? 'none');

  const { error: assignErr } = await user
    .from('trip_items')
    .update({ trip_id: trip.id })
    .eq('id', held.id);
  check('filing it moves it into the trip', !assignErr, assignErr?.message ?? '');

  const { data: stillHeld } = await user.from('trip_items').select('id').is('trip_id', null);
  check('and the holding area empties', (stillHeld ?? []).length === 0, `${stillHeld?.length}`);

  // Filing does not re-run the tier trigger (it is INSERT-only), which is
  // correct: a booking already imported must not become unfileable if a plan
  // lapses between arriving and being filed.
  const { data: inTrip } = await user
    .from('trip_items')
    .select('id, source')
    .eq('trip_id', trip.id);
  check('the item kept its "email" provenance', inTrip?.[0]?.source === 'email', inTrip?.[0]?.source ?? '');
}

console.log('\nA lapsed plan holds mail rather than dropping it');
{
  await grantTier(URL_BASE, uUser.id, 'free');

  const r = await postWebhook(postmarkPayload(`${localPart}@trips.test`, { Subject: `Lapsed ${stamp}` }));
  check('the webhook still accepts the message', r.status === 200, `HTTP ${r.status}`);

  const { data: mail } = await user
    .from('inbound_emails')
    .select('status, subject')
    .order('received_at', { ascending: false })
    .limit(1);

  check(
    'and it is held, marked as needing the plan',
    mail?.[0]?.status === 'rejected_tier',
    mail?.[0]?.status ?? 'no row'
  );

  // The address itself survives a downgrade, so upgrading again does not mean
  // re-sharing a new address with everyone.
  const { data: addr } = await admin
    .from('forwarding_addresses')
    .select('local_part')
    .eq('user_id', uUser.id)
    .maybeSingle();
  check('the address survives the downgrade', addr?.local_part === localPart, addr?.local_part ?? 'gone');
}

console.log('\nRotating an address');
{
  await grantTier(URL_BASE, uUser.id, 'pro');

  const r = await fn(user, 'smart-import', { action: 'rotate' });
  const rotated = r.data?.localPart ?? null;
  check('a new address is issued', Boolean(rotated) && rotated !== localPart, String(rotated));

  const old = await postWebhook(postmarkPayload(`${localPart}@trips.test`));
  check('the old one stops matching immediately', /"matched":false/.test(old.body), old.body.slice(0, 60));

  const fresh = await postWebhook(postmarkPayload(`${rotated}@trips.test`, { Subject: `Rotated ${stamp}` }));
  check('the new one works', fresh.status === 200, `HTTP ${fresh.status}`);

  const { data: mail } = await user
    .from('inbound_emails')
    .select('subject')
    .order('received_at', { ascending: false })
    .limit(1);
  check('and mail arrives on it', mail?.[0]?.subject?.includes('Rotated'), mail?.[0]?.subject ?? '');

  const { count } = await admin
    .from('forwarding_addresses')
    .select('user_id', { count: 'exact', head: true })
    .eq('local_part', localPart);
  check('the old address is not kept anywhere', count === 0, `${count} rows`);
}

console.log('\nExtraction needs no API key at all now');
{
  // This used to assert a 501 EXTRACTION_UNAVAILABLE. There is no such state
  // any more: the deterministic parser needs nothing configured, so the action
  // either reads the booking or says plainly that the text was not one.
  const r = await fn(user, 'smart-import', {
    action: 'extract',
    text: 'Booking reference: QQ8ZZZ\nYour flight departs 14 March 2027 at 09:20.',
  });
  check('booking text is read with no key present', !r.error, r.error?.error ?? '');
  check('the reference is found', r.data?.booking?.confirmationNumber === 'QQ8ZZZ', r.data?.booking?.confirmationNumber ?? '');
  check('and the method is reported', r.data?.method === 'patterns', String(r.data?.method));
  check(
    'the project confirms no model fallback is configured',
    r.data?.modelFallback === false,
    String(r.data?.modelFallback)
  );

  const junk = await fn(user, 'smart-import', {
    action: 'extract',
    text: 'Thanks for subscribing to our newsletter. Unsubscribe any time.',
  });
  check('text that is not a booking is refused clearly', junk.error?.code === 'UNREADABLE', `${junk.status} ${junk.error?.code}`);
}

console.log('\nCleanup');
{
  await user.from('trip_items').delete().eq('user_id', uUser.id);
  await user.from('trips').delete().eq('user_id', uUser.id);
  await user.from('inbound_emails').delete().not('id', 'is', null);
  await admin.from('forwarding_addresses').delete().eq('user_id', uUser.id);
  await admin.auth.admin.deleteUser(uUser.id).catch(() => {});

  const { count } = await admin
    .from('inbound_emails')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', uUser.id);
  check('test data removed', count === 0, `${count}`);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
