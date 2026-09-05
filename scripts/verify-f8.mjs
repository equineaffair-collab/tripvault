/**
 * F8 verification — subscription tiers, attacked from the client.
 *
 *   node scripts/verify-f8.mjs
 *
 * The test plan's F8 security item is the whole point of this file: try each
 * gated action by direct API call on a Free account and confirm the BACKEND
 * refuses, not just the interface. Everything here goes straight to PostgREST;
 * no app code is involved, so nothing the UI does can make these pass.
 *
 * Also cross-checks that the database's limits agree with lib/tiers.ts. A drift
 * between them means the app and the database disagree about what a customer
 * paid for.
 *
 * Requires "Confirm email" OFF in Supabase Auth settings.
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { TIER_LIMITS } from '../lib/tiers.ts';

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
  if (error) throw new Error(`${error.message} (is "Confirm email" off?)`);
  return data.user;
}

const addTraveler = (c, userId, name) =>
  c.from('travelers').insert({ user_id: userId, name, relationship: 'other' }).select('id').single();

const addTrip = (c, userId, name, endDate) =>
  c.from('trips').insert({ user_id: userId, name, end_date: endDate }).select('id').single();

console.log('\nF8 — subscription tiers\n');

const a = client();
const aUser = await signUpAndIn(a, {
  email: `tv-f8-${stamp}@tripvault.local`,
  password: 'Test-passw0rd!F8',
});

console.log('A new account is Free by default');
{
  const { data } = await a.from('subscriptions').select('tier').maybeSingle();
  // No row at all is the honest default: nobody has bought anything, and the
  // tier function treats a missing row as Free.
  check('no subscription row exists yet', data === null, JSON.stringify(data));
}

console.log('\nFree limits are enforced by the DATABASE, not the UI');
{
  const first = await addTraveler(a, aUser.id, `F8 first ${stamp}`);
  check('the first traveler is allowed', !first.error, first.error?.message ?? '');

  // The test plan's security item: a direct API call, no app code involved.
  const second = await addTraveler(a, aUser.id, `F8 second ${stamp}`);
  check('a SECOND traveler is refused by the backend', Boolean(second.error), second.error?.code ?? 'accepted!');
  check(
    'and the refusal explains the limit',
    /plan covers 1 traveler/i.test(second.error?.message ?? ''),
    second.error?.message ?? ''
  );

  const { count } = await a.from('travelers').select('id', { count: 'exact', head: true });
  check('only one traveler exists', count === 1, `${count}`);
}

console.log('\nFree is limited to one ACTIVE trip');
{
  const first = await addTrip(a, aUser.id, `F8 trip one ${stamp}`, '2030-01-01');
  check('the first active trip is allowed', !first.error, first.error?.message ?? '');

  const second = await addTrip(a, aUser.id, `F8 trip two ${stamp}`, '2030-06-01');
  check('a SECOND active trip is refused by the backend', Boolean(second.error), second.error?.code ?? 'accepted!');

  // A finished trip is not "active", so it must not count against the limit --
  // otherwise a Free user could never plan again after their first holiday.
  const past = await addTrip(a, aUser.id, `F8 past trip ${stamp}`, '2020-01-01');
  check('a trip in the past does not count toward the limit', !past.error, past.error?.message ?? '');
}

console.log('\nThe tier itself is not client-writable');
{
  // If this were possible, every other check in this file would be theatre.
  const { error: insErr } = await a
    .from('subscriptions')
    .insert({ user_id: aUser.id, tier: 'family', source: 'manual' });
  check('a client cannot grant itself a tier', Boolean(insErr), insErr?.code ?? 'accepted!');

  const { data: after } = await a.from('subscriptions').select('tier').maybeSingle();
  check('and no subscription appeared', after === null, JSON.stringify(after));
}

console.log('\nThe database limits agree with lib/tiers.ts');
{
  // Two sources of truth for the same numbers, so they get checked against each
  // other. A drift means the UI and the database disagree about what someone
  // paid for, which is the kind of bug that reaches a customer.
  const { data: travLimits } = await a.rpc('tier_traveler_limit', { t: 'family' });
  check('family traveler limit matches', travLimits === TIER_LIMITS.family.travelerProfiles, `db=${travLimits} app=${TIER_LIMITS.family.travelerProfiles}`);

  const { data: freeTrav } = await a.rpc('tier_traveler_limit', { t: 'free' });
  check('free traveler limit matches', freeTrav === TIER_LIMITS.free.travelerProfiles, `db=${freeTrav} app=${TIER_LIMITS.free.travelerProfiles}`);

  const { data: lifeTrav } = await a.rpc('tier_traveler_limit', { t: 'lifetime' });
  check(
    'lifetime gets Pro scope, not Family scope, in the DB too',
    lifeTrav === TIER_LIMITS.lifetime.travelerProfiles && lifeTrav !== TIER_LIMITS.family.travelerProfiles,
    `db=${lifeTrav}`
  );

  const { data: freeTrips } = await a.rpc('tier_active_trip_limit', { t: 'free' });
  check('free active-trip limit matches', freeTrips === TIER_LIMITS.free.activeTrips, `db=${freeTrips}`);

  const { data: proTrips } = await a.rpc('tier_active_trip_limit', { t: 'pro' });
  check('pro trips are unlimited in the DB too', proTrips === null, `db=${proTrips}`);
}

console.log('\ncurrent_tier reflects reality');
{
  const { data } = await a.rpc('current_tier', { uid: aUser.id });
  check('an account with no subscription reads as free', data === 'free', String(data));
}

console.log('\nCleanup');
{
  await a.from('trips').delete().eq('user_id', aUser.id);
  await a.from('travelers').delete().eq('user_id', aUser.id);
  const { count } = await a.from('travelers').select('id', { count: 'exact', head: true });
  check('test data removed', count === 0, `${count}`);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
