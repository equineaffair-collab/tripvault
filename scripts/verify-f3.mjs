/**
 * F3 verification — trips, attendees, checklist and bookings, live.
 *
 *   node scripts/verify-f3.mjs
 *
 * Covers the test plan's F3 section, including the two things only a live run
 * can show: that RLS refuses another account's traveler as an attendee, and
 * that the "Check entry requirements" path takes its fallback while F6 does not
 * exist (the Phase 5 half of that test — the Phase 8 half comes later).
 *
 * Requires "Confirm email" to be OFF in Supabase Auth settings.
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => l.trim() && !l.trim().startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    })
);

const client = () =>
  createClient(env.EXPO_PUBLIC_SUPABASE_URL, env.EXPO_PUBLIC_SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
  });

let pass = 0;
let fail = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  ok ? pass++ : fail++;
};

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

console.log('\nF3 — trip folder and checklist\n');

const a = client();
const b = client();
const aUser = await signUpAndIn(a, {
  email: `tv-f3-a-${stamp}@tripvault.local`,
  password: 'Test-passw0rd!A',
});
const bUser = await signUpAndIn(b, {
  email: `tv-f3-b-${stamp}@tripvault.local`,
  password: 'Test-passw0rd!B',
});

const mkTraveler = async (c, user, name, relationship = 'self') => {
  const { data, error } = await c
    .from('travelers')
    .insert({ user_id: user.id, name, relationship })
    .select('id')
    .single();
  if (error) throw new Error(`traveler: ${error.message}`);
  return data.id;
};

const aTrav = await mkTraveler(a, aUser, `F3 adult ${stamp}`);
const aTrav2 = await mkTraveler(a, aUser, `F3 partner ${stamp}`, 'partner');
const bTrav = await mkTraveler(b, bUser, `F3 other ${stamp}`);

console.log('Trips and attendees');
let tripId = null;
{
  const { data, error } = await a
    .from('trips')
    .insert({
      user_id: aUser.id,
      name: `Japan ${stamp}`,
      destination: 'Tokyo',
      start_date: '2027-04-01',
      end_date: '2027-04-14',
    })
    .select('id')
    .single();
  check('a trip can be created', !error, error?.message ?? '');
  tripId = data?.id ?? null;

  const { error: badDates } = await a.from('trips').insert({
    user_id: aUser.id,
    name: 'Backwards',
    start_date: '2027-05-01',
    end_date: '2027-04-01',
  });
  check('a trip ending before it starts is rejected', Boolean(badDates), badDates?.code ?? 'accepted');
}

if (tripId) {
  const { error } = await a
    .from('trip_travelers')
    .insert([
      { trip_id: tripId, traveler_id: aTrav },
      { trip_id: tripId, traveler_id: aTrav2 },
    ]);
  check('multiple attendees can be added', !error, error?.message ?? '');

  // The interesting one: the WITH CHECK requires the traveler to belong to the
  // caller too, so a guessed id from another account cannot be attached.
  const { error: cross } = await a
    .from('trip_travelers')
    .insert({ trip_id: tripId, traveler_id: bTrav });
  check("another account's traveler cannot be made an attendee", Boolean(cross), cross?.code ?? 'accepted');
}

console.log('\nChecklist');
if (tripId) {
  const defaults = [
    { label: 'Book flights', category: 'bookings' },
    { label: 'Arrange travel insurance', category: 'money_insurance' },
  ].map((d) => ({ trip_id: tripId, ...d, source: 'default' }));
  const { error } = await a.from('trip_checklist_items').insert(defaults);
  check('default items seed', !error, error?.message ?? '');

  const { data: auto, error: autoErr } = await a
    .from('trip_checklist_items')
    .insert({
      trip_id: tripId,
      label: 'Renew Sam\'s passport before travelling',
      category: 'documents',
      source: 'auto-passport',
    })
    .select('id')
    .single();
  check('an auto-generated item can be added', !autoErr, autoErr?.message ?? '');

  // The unique index is what stops the on-save check duplicating its own items.
  const { error: dup } = await a.from('trip_checklist_items').insert({
    trip_id: tripId,
    label: 'Renew Sam\'s passport before travelling',
    category: 'documents',
    source: 'auto-passport',
  });
  check('the same auto item cannot be created twice', dup?.code === '23505', dup?.code ?? 'accepted');

  // Manual items are exempt: two "call the hotel" reminders is the user's business.
  const { error: m1 } = await a.from('trip_checklist_items').insert({ trip_id: tripId, label: 'Call the hotel', source: 'manual' });
  const { error: m2 } = await a.from('trip_checklist_items').insert({ trip_id: tripId, label: 'Call the hotel', source: 'manual' });
  check('duplicate MANUAL items are allowed', !m1 && !m2, m2?.code ?? '');

  const { error: badCat } = await a
    .from('trip_checklist_items')
    .insert({ trip_id: tripId, label: 'Bad', category: 'nonsense' });
  check('an unknown category is rejected', Boolean(badCat), badCat?.code ?? 'accepted');

  if (auto) {
    const { data: done } = await a
      .from('trip_checklist_items')
      .update({ status: 'done' })
      .eq('id', auto.id)
      .select('status')
      .single();
    check('an item can be ticked off', done?.status === 'done');
  }
}

console.log('\nBookings, and F5\'s holding area');
let itemId = null;
if (tripId) {
  const { data, error } = await a
    .from('trip_items')
    .insert({ trip_id: tripId, user_id: aUser.id, type: 'flight', provider: 'Qantas', confirmation_number: 'ABC123' })
    .select('id')
    .single();
  check('a booking can be added to a trip', !error, error?.message ?? '');
  itemId = data?.id ?? null;

  // F5 needs trip_id nullable so a forwarded email has somewhere to land.
  const { data: held, error: heldErr } = await a
    .from('trip_items')
    .insert({ trip_id: null, user_id: aUser.id, type: 'accommodation', provider: 'Unmatched', source: 'email' })
    .select('id, trip_id')
    .single();
  check('an item with no trip is allowed (F5 holding area)', !heldErr && held?.trip_id === null, heldErr?.message ?? '');

  if (held) {
    const { data: moved } = await a
      .from('trip_items')
      .update({ trip_id: tripId })
      .eq('id', held.id)
      .select('trip_id')
      .single();
    check('a held item can be assigned to a trip', moved?.trip_id === tripId);
  }

  const { error: badType } = await a
    .from('trip_items')
    .insert({ trip_id: tripId, user_id: aUser.id, type: 'submarine' });
  check('an unknown booking type is rejected', Boolean(badType), badType?.code ?? 'accepted');
}

console.log('\nChecklist ↔ booking link');
if (tripId && itemId) {
  const { data: c } = await a
    .from('trip_checklist_items')
    .insert({ trip_id: tripId, label: 'Book the flight', category: 'bookings', source: 'manual' })
    .select('id')
    .single();

  const { data: linked } = await a
    .from('trip_checklist_items')
    .update({ linked_trip_item_id: itemId, status: 'done' })
    .eq('id', c.id)
    .select('linked_trip_item_id, status')
    .single();
  check('a checklist item links to a real booking', linked?.linked_trip_item_id === itemId);
  check('linking marks it done', linked?.status === 'done');

  // Removing the booking must not remove the checklist item, only the link --
  // otherwise deleting a booking would quietly erase the task too.
  await a.from('trip_items').delete().eq('id', itemId);
  const { data: after } = await a
    .from('trip_checklist_items')
    .select('id, linked_trip_item_id')
    .eq('id', c.id)
    .single();
  check('deleting the booking clears the link but keeps the item', after && after.linked_trip_item_id === null);
}

console.log('\nF6 soft integration (Phase 8 half of the test)');
{
  // The test plan asks this be checked twice: before F6 exists (the fallback is
  // the live path) and again after (the real check runs). Phase 8 has landed, so
  // this asserts the second state. Were it to start failing, F6's table has gone
  // and F3 should be quietly falling back rather than erroring.
  const { error } = await a.from('entry_requirements').select('country').limit(1);
  check('entry_requirements exists, so the real check is the live path', !error, error?.code ?? '');

  const { data } = await a
    .from('entry_requirements')
    .select('country, min_passport_validity_months, verified')
    .eq('country', 'THA')
    .maybeSingle();
  check('a destination rule can be read', Boolean(data), JSON.stringify(data ?? {}));
  check('seeded rules are marked unverified', data?.verified === false, String(data?.verified));
}

console.log('\nSecurity — cross-account isolation');
if (tripId) {
  const { data } = await b.from('trips').select('id').eq('id', tripId);
  check("user B cannot see user A's trip", (data ?? []).length === 0);

  const { data: cl } = await b.from('trip_checklist_items').select('id').eq('trip_id', tripId);
  check("user B cannot see user A's checklist", (cl ?? []).length === 0);

  const { data: its } = await b.from('trip_items').select('id').eq('trip_id', tripId);
  check("user B cannot see user A's bookings", (its ?? []).length === 0);

  const { error: plant } = await b
    .from('trip_checklist_items')
    .insert({ trip_id: tripId, label: 'planted', source: 'manual' });
  check("user B cannot add to user A's checklist", Boolean(plant), plant?.code ?? 'accepted');
}

console.log('\nCascade');
if (tripId) {
  await a.from('trips').delete().eq('id', tripId);
  const { data: cl } = await a.from('trip_checklist_items').select('id').eq('trip_id', tripId);
  const { data: its } = await a.from('trip_items').select('id').eq('trip_id', tripId);
  const { data: att } = await a.from('trip_travelers').select('traveler_id').eq('trip_id', tripId);
  check('deleting a trip removes its checklist', (cl ?? []).length === 0);
  check('deleting a trip removes its bookings', (its ?? []).length === 0);
  check('deleting a trip removes its attendees', (att ?? []).length === 0);
}

console.log('\nCleanup');
{
  await a.from('trips').delete().eq('user_id', aUser.id);
  await a.from('trip_items').delete().eq('user_id', aUser.id);
  await a.from('travelers').delete().eq('user_id', aUser.id);
  await b.from('travelers').delete().eq('user_id', bUser.id);
  const { data } = await a.from('travelers').select('id').eq('user_id', aUser.id);
  check('test data removed', (data ?? []).length === 0);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
