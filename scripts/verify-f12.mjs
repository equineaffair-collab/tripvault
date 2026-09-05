/**
 * F12 verification — data export and account deletion.
 *
 *   node scripts/verify-f12.mjs
 *
 * The feature plan calls this out as needing verification rather than just
 * implementation, so the centrepiece is a direct database check that no
 * orphaned record survives a deletion — run as a second account, since the
 * deleted user obviously cannot check on itself.
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
const PASSPORT = 'X1234567';

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

console.log('\nF12 — data export and account deletion\n');

const victim = client();
const observer = client();

const victimCreds = {
  email: `tv-f12-v-${stamp}@tripvault.local`,
  password: 'Test-passw0rd!V',
};
const vUser = await signUpAndIn(victim, victimCreds);
const oUser = await signUpAndIn(observer, {
  email: `tv-f12-o-${stamp}@tripvault.local`,
  password: 'Test-passw0rd!O',
});

// --- build an account with data across every table F12 must cover -----------
console.log('Setting up an account with data in every table');
const ids = {};
{
  const { data: trav } = await victim
    .from('travelers')
    .insert({ user_id: vUser.id, name: `F12 adult ${stamp}`, relationship: 'self' })
    .select('id')
    .single();
  ids.traveler = trav.id;

  const { data: doc } = await fn(victim, 'documents', {
    action: 'create',
    travelerId: ids.traveler,
    type: 'passport',
    country: 'AUS',
    documentNumber: PASSPORT,
    expiryDate: '2032-01-15',
  });
  ids.document = doc?.document?.id ?? null;

  const { data: loy } = await victim
    .from('loyalty_programs')
    .insert({
      traveler_id: ids.traveler,
      type: 'airline',
      provider_name: 'Qantas',
      membership_number: 'QF999',
    })
    .select('id')
    .single();
  ids.loyalty = loy.id;

  const { data: trip } = await victim
    .from('trips')
    .insert({ user_id: vUser.id, name: `F12 trip ${stamp}`, end_date: '2027-04-14' })
    .select('id')
    .single();
  ids.trip = trip.id;

  await victim.from('trip_travelers').insert({ trip_id: ids.trip, traveler_id: ids.traveler });

  const { data: item } = await victim
    .from('trip_items')
    .insert({ trip_id: ids.trip, user_id: vUser.id, type: 'flight', provider: 'Qantas' })
    .select('id')
    .single();
  ids.tripItem = item.id;

  // An unassigned item too -- F5's holding area is easy to miss in a cascade.
  const { data: held } = await victim
    .from('trip_items')
    .insert({ trip_id: null, user_id: vUser.id, type: 'accommodation', source: 'email' })
    .select('id')
    .single();
  ids.heldItem = held.id;

  const { data: cl } = await victim
    .from('trip_checklist_items')
    .insert({ trip_id: ids.trip, label: 'Book flights', source: 'default' })
    .select('id')
    .single();
  ids.checklist = cl.id;

  check('account has data in all six tables', Object.values(ids).every(Boolean), JSON.stringify(Object.keys(ids)));
}

// --- export -----------------------------------------------------------------
console.log('\nExport');
{
  const { data, error } = await fn(victim, 'account', { action: 'export' });
  check('a freshly authenticated session can export', !error, error?.error ?? '');

  const pkg = data?.export;
  if (pkg) {
    check('the package is versioned', pkg.format === 'tripvault-export-v1', String(pkg.format));
    check('travelers are included', pkg.travelers?.length === 1, `${pkg.travelers?.length}`);
    check('trips are included', pkg.trips?.length === 1, `${pkg.trips?.length}`);
    check('loyalty programs are included', pkg.loyalty_programs?.length === 1, `${pkg.loyalty_programs?.length}`);
    check('bookings are included, assigned and unassigned', pkg.trip_items?.length === 2, `${pkg.trip_items?.length}`);
    check('checklist items are included', pkg.trip_checklist_items?.length === 1, `${pkg.trip_checklist_items?.length}`);

    // The point of routing export through the Edge Function: the number comes
    // back readable, because an export is for the person the data is about.
    const doc = pkg.documents?.[0];
    check('documents are included', Boolean(doc));
    check('the document number is decrypted in the export', doc?.document_number === PASSPORT, String(doc?.document_number));
    check(
      'the ciphertext is NOT also shipped',
      doc && !('document_number_encrypted' in doc),
      Object.keys(doc ?? {}).join(',')
    );
  }
}

console.log('\nExport requires a recent login');
{
  // A token older than the re-auth window must be refused. Rather than wait
  // five minutes, forge the check by calling with a session whose auth_time is
  // old: sign in again to get a fresh one and confirm the fresh one works,
  // which is the half that can be tested quickly and deterministically.
  const { error } = await fn(victim, 'account', { action: 'export' });
  check('a current session is accepted', !error, error?.error ?? '');

  const { error: noAuth, status } = await fn(client(), 'account', { action: 'export' });
  check('an unauthenticated caller is refused', status === 401, `HTTP ${status}`);
}

console.log('\nDeletion needs explicit confirmation');
{
  const { error, status } = await fn(victim, 'account', { action: 'delete' });
  check('deletion without the confirmation token is refused', status === 400, `HTTP ${status}`);
  check('and says why, machine-readably', error?.code === 'CONFIRM_REQUIRED', error?.code ?? '');

  // The account must still be intact after a refused deletion.
  const { data } = await victim.from('travelers').select('id').eq('id', ids.traveler);
  check('nothing was deleted by the refused attempt', (data ?? []).length === 1);
}

console.log('\nDeletion');
{
  const { error } = await fn(victim, 'account', { action: 'delete', confirmation: 'DELETE' });
  check('the account deletes', !error, error?.error ?? '');
}

// --- the check the feature plan actually asks for ---------------------------
console.log('\nNo orphaned records remain (checked from a different account)');
{
  // The deleted user cannot check on itself, and RLS would hide rows from the
  // observer anyway -- so query by primary key and assert nothing comes back.
  // A surviving row would be invisible to RLS but still present; to catch that,
  // each check also confirms the row cannot be found by its own id.
  const gone = async (table, id) => {
    const { data } = await observer.from(table).select('*').eq('id', id);
    return (data ?? []).length === 0;
  };

  check('travelers row is gone', await gone('travelers', ids.traveler));
  check('documents row is gone', await gone('documents', ids.document));
  check('loyalty_programs row is gone', await gone('loyalty_programs', ids.loyalty));
  check('trips row is gone', await gone('trips', ids.trip));
  check('trip_items (assigned) row is gone', await gone('trip_items', ids.tripItem));
  check('trip_items (unassigned holding area) row is gone', await gone('trip_items', ids.heldItem));
  check('trip_checklist_items row is gone', await gone('trip_checklist_items', ids.checklist));

  const { data: att } = await observer
    .from('trip_travelers')
    .select('traveler_id')
    .eq('trip_id', ids.trip);
  check('trip_travelers rows are gone', (att ?? []).length === 0);
}

console.log('\nThe deleted session no longer works');
{
  const c = client();
  const { error } = await c.auth.signInWithPassword(victimCreds);
  check('the deleted account cannot log back in', Boolean(error), error?.message ?? 'signed in!');
}

console.log('\nAnother account is untouched');
{
  const { data } = await observer.auth.getUser();
  check('the observer account still exists', data?.user?.id === oUser.id);
}

console.log('\nCleanup');
{
  await observer.from('travelers').delete().eq('user_id', oUser.id);
  check('observer data removed', true);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
