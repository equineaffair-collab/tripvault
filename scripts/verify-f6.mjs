/**
 * F6 verification — passport validity checker, against the live project.
 *
 *   node scripts/verify-f6.mjs
 *
 * Covers the test plan's F6 section: the multi-passport recommendation against
 * a real destination rule, unverified data not being treated as verified, and
 * — the compliance one — that no visa determination happens anywhere.
 *
 * Requires "Confirm email" OFF in Supabase Auth settings.
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
  if (error) throw new Error(`${error.message} (is "Confirm email" off?)`);
  return data.user;
}

console.log('\nF6 — passport validity checker\n');

const a = client();
const anon = createClient(env.EXPO_PUBLIC_SUPABASE_URL, env.EXPO_PUBLIC_SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
});
const aUser = await signUpAndIn(a, {
  email: `tv-f6-${stamp}@tripvault.local`,
  password: 'Test-passw0rd!F6',
});

console.log('Reference data');
{
  const { data, error } = await a.from('entry_requirements').select('country').limit(100);
  check('the reference table is readable when signed in', !error, error?.message ?? '');
  check('it has destinations seeded', (data ?? []).length >= 15, `${(data ?? []).length} rows`);

  const { data: unverified } = await a
    .from('entry_requirements')
    .select('country')
    .eq('verified', false);
  // Every seeded row is unverified until someone works through the IATA
  // lookups. The app must never present these as confirmed.
  check(
    'every seeded rule is marked unverified',
    (unverified ?? []).length === (data ?? []).length,
    `${(unverified ?? []).length} unverified of ${(data ?? []).length}`
  );
}

console.log('\nF6 owns validity only — no visa determination anywhere');
{
  // The deliberate F6/F7 split. A visa column reappearing here is the single
  // clearest sign the two features have started merging back together.
  const { data } = await a.from('entry_requirements').select('*').limit(1);
  const columns = Object.keys(data?.[0] ?? {});
  const visaish = columns.filter((c) => /visa/i.test(c));
  check('no visa column exists', visaish.length === 0, columns.join(', '));
}

console.log('\nData integrity');
{
  // With RLS on and no UPDATE policy, Postgres filters the row out rather than
  // raising -- the call "succeeds" against zero rows. So the meaningful check is
  // that nothing actually changed, not that an error came back. Asserting the
  // error was the wrong test and passed for the wrong reason.
  const { data: changed } = await a
    .from('entry_requirements')
    .update({ verified: true, last_verified: '2020-01-01' })
    .eq('country', 'THA')
    .select();
  check('a client update affects no rows', (changed ?? []).length === 0, `${(changed ?? []).length} rows`);

  const { data: after } = await a
    .from('entry_requirements')
    .select('verified, last_verified')
    .eq('country', 'THA')
    .single();
  check('and the rule is genuinely unchanged', after?.verified === false && after?.last_verified === null, JSON.stringify(after));

  const { error: insErr } = await a
    .from('entry_requirements')
    .insert({ country: 'ZZZ', country_name: 'Nowhere', min_passport_validity_months: 0 });
  check('a client insert is refused outright', Boolean(insErr), insErr?.code ?? 'accepted!');
}

console.log('\nAccess');
{
  const { data } = await anon.from('entry_requirements').select('country').limit(1);
  // The policy grants SELECT to `authenticated` only. An anonymous caller gets
  // an empty set rather than the reference list.
  check('an unauthenticated caller reads nothing', (data ?? []).length === 0, `${(data ?? []).length} rows`);
}

console.log('\nMulti-passport comparison against a real rule');
{
  const { data: trav } = await a
    .from('travelers')
    .insert({ user_id: aUser.id, name: `F6 dual national ${stamp}`, relationship: 'self' })
    .select('id')
    .single();

  // Thailand: six months beyond arrival. For a trip arriving 2027-04-01, a
  // passport must be valid to 2027-10-01.
  const aus = await a.functions.invoke('documents', {
    body: {
      action: 'create',
      travelerId: trav.id,
      type: 'passport',
      country: 'AUS',
      documentNumber: `F6A${stamp}`,
      expiryDate: '2027-08-01', // too soon
      isPrimary: true,
    },
  });
  const lva = await a.functions.invoke('documents', {
    body: {
      action: 'create',
      travelerId: trav.id,
      type: 'passport',
      country: 'LVA',
      documentNumber: `F6B${stamp}`,
      expiryDate: '2031-01-01', // clears
    },
  });
  check('two passports stored for one traveler', Boolean(aus.data?.document && lva.data?.document));

  const { data: rule } = await a
    .from('entry_requirements')
    .select('min_passport_validity_months, counted_from')
    .eq('country', 'THA')
    .single();
  check('Thailand rule is six months from entry', rule?.min_passport_validity_months === 6 && rule?.counted_from === 'entry', JSON.stringify(rule));

  const { data: passports } = await a
    .from('documents')
    .select('id, country, expiry_date, is_primary')
    .eq('traveler_id', trav.id)
    .eq('type', 'passport');

  // The comparison itself is unit tested; this confirms the data it needs is
  // actually reachable in the shape the checker expects.
  const clearing = (passports ?? []).filter((p) => p.expiry_date >= '2027-10-01');
  check('exactly one passport clears the rule', clearing.length === 1, `${clearing.length} clear`);
  check('and it is the Latvian one', clearing[0]?.country === 'LVA', String(clearing[0]?.country));
  check(
    'the primary passport is the one that does NOT clear',
    (passports ?? []).find((p) => p.is_primary)?.country === 'AUS',
    'so the recommendation must override the primary'
  );

  await a.from('travelers').delete().eq('id', trav.id);
}

console.log('\nDestination can be given as a code OR a name');
{
  // The field is free text labelled "Destination". People type "Thailand",
  // not "THA", and refusing that would make the check look broken for the
  // most obvious input.
  const { data: byCode } = await a
    .from('entry_requirements').select('country').eq('country', 'THA').maybeSingle();
  check('an ICAO code resolves', byCode?.country === 'THA', String(byCode?.country));

  const { data: byName } = await a
    .from('entry_requirements').select('country').ilike('country_name', 'thailand').maybeSingle();
  check('a country name resolves, case-insensitively', byName?.country === 'THA', String(byName?.country));

  const { data: mixed } = await a
    .from('entry_requirements').select('country').ilike('country_name', 'United Kingdom').maybeSingle();
  check('a multi-word name resolves', mixed?.country === 'GBR', String(mixed?.country));
}

console.log('\nUnknown destinations');
{
  const { data } = await a
    .from('entry_requirements')
    .select('country')
    .eq('country', 'ZZZ')
    .maybeSingle();
  // Not an error: the app says the destination is not in the list and points at
  // the embassy, rather than inventing a rule for it.
  check('an unknown destination returns nothing, not a guess', data === null);
}

console.log('\nCleanup');
{
  await a.from('travelers').delete().eq('user_id', aUser.id);
  const { data } = await a.from('travelers').select('id').eq('user_id', aUser.id);
  check('test data removed', (data ?? []).length === 0);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
