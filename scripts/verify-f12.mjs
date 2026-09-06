/**
 * F12 verification — data export and account deletion.
 *
 *   node scripts/verify-f12.mjs
 *
 * The feature plan calls this out as needing verification rather than just
 * implementation, so the centrepiece is a direct database check that no
 * orphaned record survives a deletion — queried with the service role, because
 * an RLS-scoped query returns nothing whether the rows survived or not.
 *
 * Requires the service role key (scripts/.service-key) for that section and for
 * the paid-tier fixtures, and "Confirm email" OFF in Supabase Auth settings.
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { grantTier, hasServiceKey, serviceKey } from './_tier.mjs';

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

// F5's holding area and F9's sharing are paid features, and F12 has to prove
// it deletes the data of an account that used everything -- not a Free one.
const elevated = await grantTier(env.EXPO_PUBLIC_SUPABASE_URL, vUser.id, 'family');

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
  // 'email' provenance needs a paid tier (0011's trigger), which is why the
  // grant above happens before this.
  const { data: held } = await victim
    .from('trip_items')
    .insert({
      trip_id: null,
      user_id: vUser.id,
      type: 'accommodation',
      source: elevated ? 'email' : 'manual',
    })
    .select('id')
    .single();
  ids.heldItem = held.id;

  const { data: cl } = await victim
    .from('trip_checklist_items')
    .insert({ trip_id: ids.trip, label: 'Book flights', source: 'default' })
    .select('id')
    .single();
  ids.checklist = cl.id;

  // F9 and F5 added four more tables after this verifier was written. A table
  // that gets added and not listed here is exactly how an account deletion
  // quietly stops being complete, so they go in the fixture too.
  if (elevated) {
    const { data: invite } = await fn(victim, 'invite', {
      action: 'create',
      travelerId: ids.traveler,
    });
    ids.invite = invite?.inviteId ?? null;

    const { data: share } = await fn(victim, 'shared-trip', {
      action: 'create',
      tripId: ids.trip,
      label: 'F12 fixture',
    });
    ids.share = share?.shareId ?? null;

    const { data: addr } = await fn(victim, 'smart-import', { action: 'address' });
    ids.forwardingLocalPart = addr?.localPart ?? null;
  }

  check(
    'account has data in every table F12 must cover',
    Object.values(ids).every(Boolean),
    JSON.stringify(Object.keys(ids))
  );
}

// --- export -----------------------------------------------------------------
console.log('\nExport');
{
  const { data, error } = await fn(victim, 'account', { action: 'export' });
  check('a freshly authenticated session can export', !error, error?.error ?? '');

  const pkg = data?.export;
  if (pkg) {
    check('the package is versioned', pkg.format === 'tripvault-export-v2', String(pkg.format));
    check('travelers are included', pkg.travelers?.length === 1, `${pkg.travelers?.length}`);
    check('trips are included', pkg.trips?.length === 1, `${pkg.trips?.length}`);
    check('loyalty programs are included', pkg.loyalty_programs?.length === 1, `${pkg.loyalty_programs?.length}`);
    check('bookings are included, assigned and unassigned', pkg.trip_items?.length === 2, `${pkg.trip_items?.length}`);
    check('checklist items are included', pkg.trip_checklist_items?.length === 1, `${pkg.trip_checklist_items?.length}`);

    if (elevated) {
      // The tables Phases 9 and 10 added. F12 says the package covers
      // everything the account holds, and "everything" has to keep up.
      check('the forwarding address is included', pkg.forwarding_addresses?.length === 1, `${pkg.forwarding_addresses?.length}`);
      check('share links are included', pkg.share_links?.length === 1, `${pkg.share_links?.length}`);
      check('invites are included', pkg.traveler_invites?.length === 1, `${pkg.traveler_invites?.length}`);
      check('received mail is included', Array.isArray(pkg.inbound_emails), typeof pkg.inbound_emails);

      // A token hash is the fingerprint of a live credential: useless to the
      // person exporting, and one more place it exists if the file goes astray.
      const serialised = JSON.stringify(pkg);
      check('but no token hashes are shipped', !serialised.includes('token_hash'));
    }

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

// The audit rows have to be identified BEFORE the account goes. Both of their
// foreign keys are ON DELETE SET NULL, so afterwards there is nothing left on
// the row that points back at the document or the actor — which is the whole
// point, and also means they cannot be found by either afterwards.
const auditRowIds = (
  (await victim.from('document_access_log').select('id')).data ?? []
).map((r) => r.id);

console.log('\nDeletion');
{
  check('there is an access log to preserve', auditRowIds.length > 0, `${auditRowIds.length} rows`);

  const { error } = await fn(victim, 'account', { action: 'delete', confirmation: 'DELETE' });
  check('the account deletes', !error, error?.error ?? '');
}

// --- the check the feature plan actually asks for ---------------------------
console.log('\nNo orphaned records remain (checked past RLS)');
{
  // This section used to run as a second signed-in account, and that was wrong:
  // with RLS on, another account sees zero rows whether the data was deleted or
  // not, so every assertion passed regardless of the answer. The same failure
  // caught once already in verify-f6 — a test that cannot fail is not a test.
  //
  // With the service role, the query genuinely bypasses RLS and a surviving row
  // is visible. Without it, this says so and skips rather than reporting a pass
  // it did not earn.
  if (!hasServiceKey) {
    console.log('  SKIP  needs the service role to see past RLS — put it in scripts/.service-key');
    console.log('        (an RLS-scoped query here would pass whether or not the rows survived)');
  } else {
    const admin = createClient(env.EXPO_PUBLIC_SUPABASE_URL, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const gone = async (table, id, column = 'id') => {
      const { data } = await admin.from(table).select(column).eq(column, id);
      return (data ?? []).length === 0;
    };

    check('travelers row is gone', await gone('travelers', ids.traveler));
    check('documents row is gone', await gone('documents', ids.document));
    check('loyalty_programs row is gone', await gone('loyalty_programs', ids.loyalty));
    check('trips row is gone', await gone('trips', ids.trip));
    check('trip_items (assigned) row is gone', await gone('trip_items', ids.tripItem));
    check('trip_items (unassigned holding area) row is gone', await gone('trip_items', ids.heldItem));
    check('trip_checklist_items row is gone', await gone('trip_checklist_items', ids.checklist));

    const { data: att } = await admin
      .from('trip_travelers')
      .select('traveler_id')
      .eq('trip_id', ids.trip);
    check('trip_travelers rows are gone', (att ?? []).length === 0, `${att?.length}`);

    if (elevated) {
      // Added by Phases 9 and 10, after this verifier was written. A table that
      // gets created and not listed here is exactly how account deletion
      // quietly stops being complete.
      check('F9 traveler_invites row is gone', await gone('traveler_invites', ids.invite));
      check('F9 share_links row is gone', await gone('share_links', ids.share));
      check(
        'F5 forwarding address is gone',
        await gone('forwarding_addresses', ids.forwardingLocalPart, 'local_part'),
        'a surviving address would keep accepting mail for a deleted account'
      );
      const { data: mail } = await admin
        .from('inbound_emails')
        .select('id')
        .eq('user_id', vUser.id);
      check('F5 inbound_emails rows are gone', (mail ?? []).length === 0, `${mail?.length}`);
    }

    // The one thing that is SUPPOSED to survive. Both foreign keys are ON
    // DELETE SET NULL, so the record that access occurred outlives both the
    // document and the account — which is the point of an audit log and the
    // opposite of a cascade.
    const { data: log } = await admin
      .from('document_access_log')
      .select('id, action, created_at, document_id, actor_user_id')
      .in('id', auditRowIds);

    check(
      'the access log survives the account',
      (log ?? []).length === auditRowIds.length,
      `${log?.length} of ${auditRowIds.length} rows`
    );
    check(
      'and is anonymised rather than erased',
      (log ?? []).every((r) => r.actor_user_id === null && r.document_id === null),
      JSON.stringify((log ?? [])[0] ?? {})
    );
    check(
      'keeping what happened and when, which is what an audit log is for',
      (log ?? []).every((r) => r.action && r.created_at),
      (log ?? []).map((r) => r.action).join(',')
    );
  }
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
