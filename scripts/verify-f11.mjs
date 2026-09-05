/**
 * F11 verification — runs the traveler-profile section of docs/tripvault-test-plan.md
 * against the live Supabase project, including the cross-account security test
 * that has to be done via the API rather than the UI.
 *
 *   node scripts/verify-f11.mjs
 *
 * Requires "Confirm email" to be OFF in Supabase Auth settings, so the script
 * can sign its two throwaway users straight in. Turn it back on afterwards.
 */
import { createClient } from '@supabase/supabase-js';
import { grantTier, hasServiceKey, NO_KEY_NOTICE } from './_tier.mjs';
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

const URL_ = env.EXPO_PUBLIC_SUPABASE_URL;
const KEY = env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
const client = () => createClient(URL_, KEY, { auth: { persistSession: false } });

let pass = 0;
let fail = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  ok ? pass++ : fail++;
};

const stamp = Date.now();
const userA = { email: `tv-a-${stamp}@tripvault.local`, password: 'Test-passw0rd!A' };
const userB = { email: `tv-b-${stamp}@tripvault.local`, password: 'Test-passw0rd!B' };

async function signUpAndIn(c, creds) {
  const { error: upErr } = await c.auth.signUp(creds);
  if (upErr && !/already registered/i.test(upErr.message)) throw new Error(upErr.message);
  const { data, error } = await c.auth.signInWithPassword(creds);
  if (error) {
    throw new Error(
      `${error.message}\n\n  Sign-in failed. If this says "Email not confirmed", turn OFF ` +
        `Auth > Sign In / Providers > "Confirm email" in the Supabase dashboard and re-run.`
    );
  }
  return data.user;
}

console.log('\nF11 — traveler profile management\n');

const a = client();
const b = client();
const aUser = await signUpAndIn(a, userA);
const bUser = await signUpAndIn(b, userB);
console.log(`  (test users: ${aUser.id.slice(0, 8)}… and ${bUser.id.slice(0, 8)}…)\n`);

console.log("F8's tier gate applies here (Phase 6 onward)");
{
  // The test plan asks for exactly this: a Free account blocked from a second
  // profile, and a Family account allowed up to six. The first half needs no
  // elevation, so it always runs.
  const { error: firstErr } = await a
    .from('travelers')
    .insert({ user_id: aUser.id, name: `gate first ${stamp}`, relationship: 'self' });
  check('a Free account can create its first profile', !firstErr, firstErr?.message ?? '');

  const { error: secondErr } = await a
    .from('travelers')
    .insert({ user_id: aUser.id, name: `gate second ${stamp}`, relationship: 'partner' });
  check('a Free account is blocked from a second', Boolean(secondErr), secondErr?.code ?? 'accepted!');

  await a.from('travelers').delete().eq('user_id', aUser.id);
}

const elevated = await grantTier(URL_, aUser.id, 'family');
if (!elevated) {
  console.log('\nMulti-profile checks');
  console.log(NO_KEY_NOTICE);
} else {
  console.log('\n(test account granted Family so multi-profile checks can run)');
}

console.log('\nFunctional — relationship types and the is_minor flag');
const created = {};
for (const rel of elevated ? ['self', 'partner', 'child', 'other'] : ['child']) {
  const { data, error } = await a
    .from('travelers')
    .insert({ user_id: aUser.id, name: `Test ${rel}`, relationship: rel })
    .select('id, relationship, is_minor')
    .single();

  if (error) {
    check(`create profile with relationship "${rel}"`, false, error.message);
    continue;
  }
  created[rel] = data.id;
  check(`create profile with relationship "${rel}"`, true);
  check(
    `  is_minor is ${rel === 'child'} for "${rel}"`,
    data.is_minor === (rel === 'child'),
    `got ${data.is_minor}`
  );
}

console.log('\nSecurity — is_minor cannot be forged by the client');
if (elevated) {
  const { data, error } = await a
    .from('travelers')
    .insert({ user_id: aUser.id, name: 'Forged child', relationship: 'child', is_minor: false })
    .select('is_minor')
    .single();
  check(
    'client-supplied is_minor=false on a child profile is overridden',
    !error && data.is_minor === true,
    error ? error.message : `stored ${data?.is_minor}`
  );
} else {
  // Needs a second profile, so it needs a paid tier. The UPDATE-based forge
  // test below covers the same property and runs either way.
  console.log(NO_KEY_NOTICE);
}

{
  // The case a column-scoped `update of relationship` trigger misses: the
  // trigger never fires, so a forged is_minor sticks. Reachable by any direct
  // API call, since RLS permits this write on the user's own row.
  const { data, error } = await a
    .from('travelers')
    .update({ is_minor: false })
    .eq('id', created.child)
    .select('is_minor')
    .single();
  check(
    'is_minor cannot be forged by updating that column alone',
    !error && data.is_minor === true,
    error ? error.message : `stored ${data?.is_minor}`
  );
}

console.log('\nSecurity — cross-account isolation (direct API, not the UI)');
{
  const { data } = await b.from('travelers').select('id');
  const leaked = (data ?? []).filter((r) => Object.values(created).includes(r.id));
  check("user B cannot list user A's profiles", leaked.length === 0, `${leaked.length} leaked`);
}
{
  const target = Object.values(created)[0];
  const { data } = await b.from('travelers').select('id').eq('id', target);
  check("user B cannot read user A's profile by id", (data ?? []).length === 0);

  const { data: upd } = await b.from('travelers').update({ name: 'hacked' }).eq('id', target).select();
  check("user B cannot update user A's profile", (upd ?? []).length === 0);

  const { data: del } = await b.from('travelers').delete().eq('id', target).select();
  check("user B cannot delete user A's profile", (del ?? []).length === 0);

  const { data: still } = await a.from('travelers').select('name').eq('id', target).single();
  check("user A's profile survived B's attempts", Boolean(still?.name), String(still?.name));
}
{
  const { error } = await b
    .from('travelers')
    .insert({ user_id: aUser.id, name: 'Planted', relationship: 'other' });
  check('user B cannot insert a profile owned by user A', Boolean(error), error?.code ?? 'no error');
}

console.log('\nConstraints');
{
  const { error } = await a
    .from('travelers')
    .insert({ user_id: aUser.id, name: 'Bad rel', relationship: 'grandparent' });
  check('an unknown relationship value is rejected', Boolean(error), error?.code ?? 'accepted');

  const { error: blank } = await a
    .from('travelers')
    .insert({ user_id: aUser.id, name: '   ', relationship: 'other' });
  check('a blank name is rejected', Boolean(blank), blank?.code ?? 'accepted');
}

console.log('\nCleanup');
{
  const { error } = await a.from('travelers').delete().eq('user_id', aUser.id);
  check('test profiles removed', !error, error?.message ?? '');
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
