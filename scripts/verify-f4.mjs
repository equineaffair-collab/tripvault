/**
 * F4 verification — loyalty program storage, against the live project.
 *
 *   node scripts/verify-f4.mjs
 *
 * Covers the test plan's F4 section: multiple programs per traveler with no
 * accidental one-per-type constraint, nothing that fetches a point balance, and
 * the cross-account isolation that can only be checked through the API.
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
        `Providers > "Confirm email" in the Supabase dashboard and re-run.`
    );
  }
  return data.user;
}

console.log('\nF4 — loyalty program storage\n');

const a = client();
const b = client();
const aUser = await signUpAndIn(a, {
  email: `tv-f4-a-${stamp}@tripvault.local`,
  password: 'Test-passw0rd!A',
});
const bUser = await signUpAndIn(b, {
  email: `tv-f4-b-${stamp}@tripvault.local`,
  password: 'Test-passw0rd!B',
});

const mk = async (c, user, name) => {
  const { data, error } = await c
    .from('travelers')
    .insert({ user_id: user.id, name, relationship: 'self' })
    .select('id')
    .single();
  if (error) throw new Error(`could not create traveler: ${error.message}`);
  return data.id;
};

const aTraveler = await mk(a, aUser, `F4 traveler ${stamp}`);
const bTraveler = await mk(b, bUser, `F4 other ${stamp}`);

const add = (c, travelerId, row) =>
  c.from('loyalty_programs').insert({ traveler_id: travelerId, ...row }).select().single();

console.log('Functional — multiple programs per traveler');
{
  const { error: e1 } = await add(a, aTraveler, {
    type: 'airline',
    provider_name: 'Qantas Frequent Flyer',
    membership_number: 'QF1234567890',
    tier_status: 'Gold',
  });
  check('a first program saves', !e1, e1?.message ?? '');

  // The test plan asks specifically that no one-per-type constraint exists.
  const { error: e2 } = await add(a, aTraveler, {
    type: 'airline',
    provider_name: 'Singapore Airlines KrisFlyer',
    membership_number: 'SQ9876543210',
  });
  check('a second program of the SAME type is allowed', !e2, e2?.message ?? '');

  const { error: e3 } = await add(a, aTraveler, {
    type: 'hotel',
    provider_name: 'Hilton Honors',
    membership_number: 'HH555000',
  });
  check('a different type is allowed', !e3, e3?.message ?? '');

  const { data } = await a.from('loyalty_programs').select('id').eq('traveler_id', aTraveler);
  check('all three are stored', (data ?? []).length === 3, `${(data ?? []).length} rows`);
}

console.log('\nConstraints');
{
  const { error } = await add(a, aTraveler, {
    type: 'airline',
    provider_name: 'Qantas Frequent Flyer',
    membership_number: 'QF1234567890',
  });
  check('an exact duplicate is rejected', error?.code === '23505', error?.code ?? 'accepted');

  const { error: badType } = await add(a, aTraveler, {
    type: 'spaceship',
    provider_name: 'Nope',
    membership_number: 'X1',
  });
  check('an unknown type is rejected', Boolean(badType), badType?.code ?? 'accepted');

  const { error: blank } = await add(a, aTraveler, {
    type: 'other',
    provider_name: '   ',
    membership_number: 'X1',
  });
  check('a blank provider is rejected', Boolean(blank), blank?.code ?? 'accepted');
}

console.log('\nScope — no point balances anywhere');
{
  // F4 is storage only. If a balance column ever appears, that is scope creep
  // the feature plan explicitly ruled out, and this catches it.
  const { data } = await a.from('loyalty_programs').select('*').eq('traveler_id', aTraveler).limit(1);
  const columns = Object.keys(data?.[0] ?? {});
  const balanceish = columns.filter((c) => /balance|points|miles/i.test(c));
  check('no balance/points/miles column exists', balanceish.length === 0, columns.join(', '));
}

console.log('\nSecurity — cross-account isolation');
{
  const { data } = await b.from('loyalty_programs').select('id').eq('traveler_id', aTraveler);
  check("user B cannot read user A's programs", (data ?? []).length === 0);

  const { error } = await add(b, aTraveler, {
    type: 'airline',
    provider_name: 'Planted',
    membership_number: 'HACK1',
  });
  check("user B cannot attach a program to user A's traveler", Boolean(error), error?.code ?? 'accepted');

  const { data: upd } = await b
    .from('loyalty_programs')
    .update({ provider_name: 'hacked' })
    .eq('traveler_id', aTraveler)
    .select();
  check("user B cannot update user A's programs", (upd ?? []).length === 0);

  const { data: del } = await b
    .from('loyalty_programs')
    .delete()
    .eq('traveler_id', aTraveler)
    .select();
  check("user B cannot delete user A's programs", (del ?? []).length === 0);
}

console.log('\nCascade (F12 depends on this)');
{
  await a.from('travelers').delete().eq('id', aTraveler);
  const { data } = await a.from('loyalty_programs').select('id').eq('traveler_id', aTraveler);
  check('deleting a traveler removes their programs', (data ?? []).length === 0);
}

console.log('\nCleanup');
{
  await a.from('travelers').delete().eq('user_id', aUser.id);
  await b.from('travelers').delete().eq('user_id', bUser.id);
  const { data } = await b.from('travelers').select('id').eq('id', bTraveler);
  check('test travelers removed', (data ?? []).length === 0);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
