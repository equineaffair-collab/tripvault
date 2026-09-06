/**
 * F9 verification — family member access, both mechanisms, live.
 *
 *   node scripts/verify-f9.mjs
 *
 * The parts worth running against the real database are the scoping claims,
 * because every one of them is a promise made to someone about what a third
 * party can see. So this signs in as an actual linked member and an actual
 * anonymous share recipient, and checks what each of them can reach — rather
 * than checking that the app hides a button.
 *
 * Requires the service role key (scripts/.service-key) because F9 is a
 * Family-tier feature and a tier cannot be granted from a client. Requires
 * "Confirm email" OFF in Supabase Auth settings.
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { grantTier, hasServiceKey, serviceKey } from './_tier.mjs';
import {
  describeShareLink,
  inviteBlockReason,
  shareUrl,
} from '../lib/familyAccessFormat.ts';
import { GATED_FEATURES, TIERS, hasFeature } from '../lib/tiers.ts';

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

const client = () =>
  createClient(URL_BASE, env.EXPO_PUBLIC_SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
  });

let pass = 0;
let fail = 0;
let skipped = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  ok ? pass++ : fail++;
};

if (!hasServiceKey) {
  console.log('\nF9 — family member access\n');
  console.log('  SKIP  F9 is a Family-tier feature, and a tier can only be granted with the');
  console.log('        service role. Put the key in scripts/.service-key and re-run.\n');
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

/** The share recipient's view. No session, no apikey — a stranger with a link. */
const viewJson = (token) =>
  fetch(`${URL_BASE}/functions/v1/shared-trip`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'view', token }),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

const viewHtml = (token) =>
  fetch(shareUrl(URL_BASE, token)).then(async (r) => ({
    status: r.status,
    // The headers matter as much as the body here: the whole point of this
    // request is what a browser will actually do with the response.
    contentType: r.headers.get('content-type'),
    robots: r.headers.get('x-robots-tag'),
    cacheControl: r.headers.get('cache-control'),
    body: await r.text(),
  }));

/**
 * Rate limiting is keyed on the caller's address, so repeated runs from this
 * machine would eventually lock the suite out of its own tests. The limit is
 * exercised deliberately below and the slate wiped either side of it.
 */
const clearAttempts = () => admin.from('share_link_attempts').delete().gt('id', 0);

console.log('\nF9 — family member access\n');
await clearAttempts();

// ---------------------------------------------------------------------------
// Cast
// ---------------------------------------------------------------------------
const organizer = client();  // runs the account, owns the trips
const member = client();     // the family member who gets a linked login
const other = client();      // an unrelated account, for the negative controls

const oUser = await signUpAndIn(organizer, {
  email: `tv-f9-org-${stamp}@tripvault.local`,
  password: 'Test-passw0rd!O',
});
const mUser = await signUpAndIn(member, {
  email: `tv-f9-mem-${stamp}@tripvault.local`,
  password: 'Test-passw0rd!M',
});
const xUser = await signUpAndIn(other, {
  email: `tv-f9-oth-${stamp}@tripvault.local`,
  password: 'Test-passw0rd!X',
});

console.log('A Free account cannot use F9 at all');
{
  // Checked BEFORE the tier is granted, so this is the real refusal and not a
  // reconstruction of one.
  const { data: freeTrav } = await organizer
    .from('travelers')
    .insert({ user_id: oUser.id, name: `F9 self ${stamp}`, relationship: 'self' })
    .select('id')
    .single();

  const r = await fn(organizer, 'invite', { action: 'create', travelerId: freeTrav.id });
  check('a Free account is refused an invite', Boolean(r.error), r.error?.error ?? 'accepted!');
  check(
    'and the refusal names the tier that would allow it',
    /family/i.test(r.error?.error ?? ''),
    r.error?.error ?? ''
  );

  const { data: freeTrip } = await organizer
    .from('trips')
    .insert({ user_id: oUser.id, name: `F9 free trip ${stamp}`, end_date: '2030-03-01' })
    .select('id')
    .single();

  const s = await fn(organizer, 'shared-trip', { action: 'create', tripId: freeTrip.id });
  check('a Free account is refused a share link', Boolean(s.error), s.error?.error ?? 'accepted!');

  await organizer.from('trips').delete().eq('id', freeTrip.id);
  await organizer.from('travelers').delete().eq('id', freeTrav.id);
}

await grantTier(URL_BASE, oUser.id, 'family');

// ---------------------------------------------------------------------------
// The account this feature is for
// ---------------------------------------------------------------------------
console.log('\nSetting up a Family account with two trips');
const ids = {};
{
  const mk = async (name, relationship) => {
    const { data, error } = await organizer
      .from('travelers')
      .insert({ user_id: oUser.id, name, relationship })
      .select('id')
      .single();
    if (error) throw new Error(`traveler ${name}: ${error.message}`);
    return data.id;
  };

  ids.sam = await mk(`F9 Sam ${stamp}`, 'partner');
  ids.pat = await mk(`F9 Pat ${stamp}`, 'other');
  ids.ada = await mk(`F9 Ada ${stamp}`, 'child');

  const mkTrip = async (name) => {
    const { data, error } = await organizer
      .from('trips')
      .insert({ user_id: oUser.id, name, destination: 'Tokyo', end_date: '2030-05-01' })
      .select('id')
      .single();
    if (error) throw new Error(`trip ${name}: ${error.message}`);
    return data.id;
  };

  ids.shared = await mkTrip(`F9 shared trip ${stamp}`);
  ids.private = await mkTrip(`F9 private trip ${stamp}`);

  await organizer.from('trip_travelers').insert([
    { trip_id: ids.shared, traveler_id: ids.sam },
    { trip_id: ids.shared, traveler_id: ids.pat },
    { trip_id: ids.private, traveler_id: ids.pat },
  ]);

  const { data: item } = await organizer
    .from('trip_items')
    .insert({
      trip_id: ids.shared,
      user_id: oUser.id,
      type: 'flight',
      provider: `F9 Airways ${stamp}`,
      confirmation_number: 'ZZ9ABC',
      amount_due: 1234.56,
      item_date: '2030-04-20T09:00:00Z',
    })
    .select('id')
    .single();
  ids.item = item.id;

  await organizer.from('trip_items').insert({
    trip_id: ids.private,
    user_id: oUser.id,
    type: 'accommodation',
    provider: `F9 Secret Hotel ${stamp}`,
  });

  const { data: task } = await organizer
    .from('trip_checklist_items')
    .insert({ trip_id: ids.shared, label: `F9 pack chargers ${stamp}`, category: 'planning' })
    .select('id')
    .single();
  ids.task = task.id;

  // Sam's and Pat's passports, through the Edge Function -- `documents` has no
  // client INSERT policy, which is F1's design and still holds here.
  const mkDoc = async (travelerId, number) => {
    const { data } = await fn(organizer, 'documents', {
      action: 'create',
      travelerId,
      type: 'passport',
      country: 'AUS',
      documentNumber: number,
      expiryDate: '2033-06-30',
    });
    return data?.document?.id ?? null;
  };
  ids.samDoc = await mkDoc(ids.sam, 'PA1234567');
  ids.patDoc = await mkDoc(ids.pat, 'PB7654321');

  check('the fixture built', Boolean(ids.samDoc && ids.patDoc && ids.item), JSON.stringify(ids));
}

// ===========================================================================
// MECHANISM 1 — the linked login
// ===========================================================================
console.log('\nMechanism 1 — inviting a family member');
let code = null;
{
  const r = await fn(organizer, 'invite', { action: 'create', travelerId: ids.sam });
  code = r.data?.code ?? null;
  check('an invite is issued', Boolean(code), r.error?.error ?? '');
  check(
    'the code has real entropy, not a guessable id',
    typeof code === 'string' && /^[A-Za-z0-9_-]{43}$/.test(code),
    String(code).length + ' chars'
  );

  // The organizer can see the invite exists but can never read the code back.
  const { data: rows } = await organizer
    .from('traveler_invites')
    .select('*')
    .eq('traveler_id', ids.sam);
  const columns = Object.keys(rows?.[0] ?? {});
  check('no plaintext token column exists', !columns.includes('token'), columns.join(','));
  check(
    'the stored hash is not the code itself',
    rows?.[0]?.token_hash !== code && /^[0-9a-f]{64}$/.test(rows?.[0]?.token_hash ?? ''),
    rows?.[0]?.token_hash?.slice(0, 12) ?? ''
  );

  const dup = await fn(organizer, 'invite', { action: 'create', travelerId: ids.sam });
  check('a second live invite for the same profile is refused', Boolean(dup.error), dup.error?.error ?? 'accepted!');

  const child = await fn(organizer, 'invite', { action: 'create', travelerId: ids.ada });
  check('a child profile cannot be given its own login', Boolean(child.error), child.error?.error ?? 'accepted!');
  check(
    'and the app would have said so first',
    inviteBlockReason({ tier: 'family', traveler: { name: 'Ada', isMinor: true, linkedAuthUserId: null } }) !== null
  );

  const stranger = await fn(other, 'invite', { action: 'create', travelerId: ids.sam });
  check("another account cannot invite someone else's profile", Boolean(stranger.error), stranger.error?.error ?? 'accepted!');

  const { data: peek } = await other.from('traveler_invites').select('id');
  check("another account cannot see the organizer's invites", (peek ?? []).length === 0, `${peek?.length}`);
}

console.log('\nThe link itself cannot be written by a client');
{
  // The whole gate -- tier, child rule, invite -- would be bypassable if the
  // organizer could simply write this column. The test plan's shape for F8
  // applies here too: attack it by direct API call.
  const { error } = await organizer
    .from('travelers')
    .update({ linked_auth_user_id: xUser.id })
    .eq('id', ids.pat);
  check('the organizer cannot grant a login by direct write', Boolean(error), error?.message ?? 'accepted!');

  const { data: after } = await organizer
    .from('travelers')
    .select('linked_auth_user_id')
    .eq('id', ids.pat)
    .single();
  check('and the column is genuinely unchanged', after.linked_auth_user_id === null, String(after.linked_auth_user_id));
}

console.log('\nAccepting an invite');
{
  const wrong = await fn(member, 'invite', { action: 'accept', code: 'x'.repeat(43) });
  check('a wrong code is refused', Boolean(wrong.error), wrong.error?.error ?? 'accepted!');
  check(
    'and says nothing about whether it ever existed',
    !/expired|revoked|used/i.test(wrong.error?.error ?? ''),
    wrong.error?.error ?? ''
  );

  const own = await fn(organizer, 'invite', { action: 'accept', code });
  check('the organizer cannot accept their own invite', Boolean(own.error), own.error?.error ?? 'accepted!');

  const ok = await fn(member, 'invite', { action: 'accept', code });
  check('the family member accepts it', !ok.error, ok.error?.error ?? '');

  const again = await fn(other, 'invite', { action: 'accept', code });
  check('the same code cannot be used twice', Boolean(again.error), again.error?.error ?? 'accepted!');
}

console.log('\nWhat the linked member can see — and cannot');
{
  const { data: trips } = await member.from('trips').select('id, name');
  const tripIds = (trips ?? []).map((t) => t.id);
  check('they see the trip they are on', tripIds.includes(ids.shared), tripIds.join(','));
  check('they do NOT see the trip they are not on', !tripIds.includes(ids.private), `${tripIds.length} trips`);

  const { data: items } = await member.from('trip_items').select('id, trip_id, provider');
  check(
    'they see that trip’s bookings',
    items?.some((i) => i.id === ids.item),
    `${items?.length} items`
  );
  check(
    'and none from the other trip',
    !items?.some((i) => i.trip_id === ids.private),
    (items ?? []).map((i) => i.provider).join(' | ')
  );

  const { data: tasks } = await member.from('trip_checklist_items').select('id, trip_id');
  check('they see the checklist for their trip', tasks?.some((t) => t.id === ids.task), `${tasks?.length}`);
  check('and no checklist from the other trip', !tasks?.some((t) => t.trip_id === ids.private));

  const { data: docs } = await member.from('documents').select('id, traveler_id');
  const docIds = (docs ?? []).map((d) => d.id);
  check('they see their OWN document', docIds.includes(ids.samDoc), `${docIds.length}`);
  check("they do NOT see a co-traveller's document", !docIds.includes(ids.patDoc), docIds.join(','));

  const { data: profiles } = await member.from('travelers').select('id, name, is_minor');
  const profileIds = (profiles ?? []).map((p) => p.id);
  check('they see only their own profile row', profileIds.length === 1 && profileIds[0] === ids.sam, `${profileIds.length}`);
  // is_minor is called out in the feature plan as a sensitive signal about a
  // real person. A linked member has no business seeing it for anyone else.
  check('so a co-traveller’s minor flag never reaches them', !profileIds.includes(ids.ada));

  const { data: loyalty } = await member.from('loyalty_programs').select('id');
  check('they see none of the organizer’s loyalty programs', (loyalty ?? []).length === 0, `${loyalty?.length}`);

  const { data: subs } = await member.from('subscriptions').select('tier');
  check('they see none of the organizer’s billing', (subs ?? []).length === 0, `${subs?.length}`);
}

console.log('\nRead-only means read-only, enforced by the database');
{
  // Each of these is attempted directly against PostgREST. With RLS on and no
  // write policy, a write silently affects zero rows rather than erroring --
  // so every case checks the DATA, not just the response.
  await member.from('trips').update({ name: 'HACKED' }).eq('id', ids.shared);
  const { data: trip } = await organizer.from('trips').select('name').eq('id', ids.shared).single();
  check('they cannot rename the trip', !trip.name.includes('HACKED'), trip.name);

  await member.from('trip_checklist_items').update({ status: 'done' }).eq('id', ids.task);
  const { data: task } = await organizer
    .from('trip_checklist_items')
    .select('status')
    .eq('id', ids.task)
    .single();
  // The feature plan leaves this as an open question and leans read-only for
  // v1. It stays answered as no until someone adds a policy on purpose.
  check('they cannot tick off a checklist item', task.status === 'todo', task.status);

  const { error: insErr } = await member
    .from('trip_checklist_items')
    .insert({ trip_id: ids.shared, label: 'added by linked member' });
  check('they cannot add a checklist item', Boolean(insErr), insErr?.code ?? 'accepted!');

  await member.from('trip_items').delete().eq('id', ids.item);
  const { data: stillThere } = await organizer
    .from('trip_items')
    .select('id')
    .eq('id', ids.item)
    .maybeSingle();
  check('they cannot delete a booking', Boolean(stillThere), 'gone!');

  const { error: docErr } = await member
    .from('documents')
    .delete()
    .eq('id', ids.samDoc);
  const { data: docLeft } = await organizer
    .from('documents')
    .select('id')
    .eq('id', ids.samDoc)
    .maybeSingle();
  check('they cannot delete even their own document', Boolean(docLeft), docErr?.message ?? 'gone!');
}

console.log('\nOne login, one profile');
{
  const second = await fn(organizer, 'invite', { action: 'create', travelerId: ids.pat });
  const r = await fn(member, 'invite', { action: 'accept', code: second.data?.code });
  check(
    'a login already linked elsewhere cannot collect a second profile',
    Boolean(r.error),
    r.error?.error ?? 'accepted!'
  );
  await organizer.from('traveler_invites').delete().eq('traveler_id', ids.pat);
}

console.log('\nRevoking');
{
  const { error } = await organizer
    .from('travelers')
    .update({ linked_auth_user_id: null })
    .eq('id', ids.sam);
  check('the organizer can revoke without a server round trip', !error, error?.message ?? '');

  const { data: trips } = await member.from('trips').select('id');
  check('the linked member immediately sees nothing', (trips ?? []).length === 0, `${trips?.length}`);

  const { data: docs } = await member.from('documents').select('id');
  check('including their own documents', (docs ?? []).length === 0, `${docs?.length}`);

  // Their account is untouched -- they are a genuine account holder, and
  // revoking removes what they can see, not who they are.
  const { data: who } = await member.auth.getUser();
  check('but their account still exists', who.user?.id === mUser.id);

  // Re-invitable afterwards, which the one-pending index would block if the
  // invite row had been left behind.
  await organizer.from('traveler_invites').delete().eq('traveler_id', ids.sam);
  const again = await fn(organizer, 'invite', { action: 'create', travelerId: ids.sam });
  check('and the profile can be invited again', Boolean(again.data?.code), again.error?.error ?? '');
  await organizer.from('traveler_invites').delete().eq('traveler_id', ids.sam);
}

// ===========================================================================
// MECHANISM 2 — the one-off share link
// ===========================================================================
console.log('\nMechanism 2 — sharing a trip with an outsider');
let plainToken = null;
let docToken = null;
{
  const r = await fn(organizer, 'shared-trip', {
    action: 'create',
    tripId: ids.shared,
    label: 'The neighbour',
  });
  plainToken = r.data?.token ?? null;
  check('a share link is created', Boolean(plainToken), r.error?.error ?? '');
  check('documents are OFF unless asked for', r.data?.includesDocuments === false, String(r.data?.includesDocuments));

  const { data: rows } = await organizer.from('share_links').select('*').eq('trip_id', ids.shared);
  const columns = Object.keys(rows?.[0] ?? {});
  check('no plaintext token column exists', !columns.includes('token'), columns.join(','));

  const stranger = await fn(other, 'shared-trip', { action: 'create', tripId: ids.shared });
  check("another account cannot share someone else's trip", Boolean(stranger.error), stranger.error?.error ?? 'accepted!');

  const { data: peek } = await other.from('share_links').select('id');
  check("another account cannot list the organizer's links", (peek ?? []).length === 0, `${peek?.length}`);
}

console.log('\nWhat a stranger with the link actually gets');
{
  const r = await viewJson(plainToken);
  check('the link opens with no account at all', r.status === 200, `HTTP ${r.status}`);
  check('the trip is there', r.body?.trip?.name?.includes('F9 shared trip'), r.body?.trip?.name ?? '');
  check('so is the itinerary', r.body?.items?.length === 1, `${r.body?.items?.length} items`);
  check('and the checklist', r.body?.checklist?.length >= 1, `${r.body?.checklist?.length}`);
  check('documents are empty', (r.body?.documents ?? []).length === 0, `${r.body?.documents?.length}`);

  // What a booking cost is the organizer's business. An emergency contact needs
  // where to be and when.
  const serialised = JSON.stringify(r.body);
  check('the amount paid is not shared', !serialised.includes('1234.56'));
  check('and no document number appears anywhere in the payload', !/PA1234567|PB7654321/.test(serialised));

  // The page a recipient opens. The previous version of this asserted the body
  // contained "<!doctype html>", which passed while the page did NOT render:
  // Supabase's gateway rewrites an HTML Content-Type from the default functions
  // domain to text/plain, so the recipient was shown raw markup. What matters
  // is that the Content-Type and the body agree, so the browser renders
  // something a person can read — that is what is checked now.
  const page = await viewHtml(plainToken);
  const contentType = page.contentType ?? '';

  check('the same link opens for a recipient', page.status === 200, `HTTP ${page.status}`);
  check('the page shows the trip', page.body.includes('F9 shared trip'), '');
  check(
    'the body matches the Content-Type the browser is actually given',
    contentType.includes('text/html')
      ? page.body.includes('<!doctype html>')
      : !page.body.includes('<!doctype html>'),
    contentType
  );
  check('the page carries no Documents section', !/documents/i.test(page.body.split('CHECKLIST')[1] ?? page.body), '');
  check('and asks not to be indexed', (page.robots ?? '').includes('noindex'), page.robots ?? '');
  check('and is not cached anywhere', (page.cacheControl ?? '').includes('no-store'), page.cacheControl ?? '');
}

console.log('\nDocuments, only when explicitly turned on');
{
  const r = await fn(organizer, 'shared-trip', {
    action: 'create',
    tripId: ids.shared,
    label: 'Emergency contact',
    includesDocuments: true,
    expiresInDays: 7,
  });
  docToken = r.data?.token ?? null;
  check('a second link can carry documents', r.data?.includesDocuments === true, r.error?.error ?? '');
  check('and it expires', Boolean(r.data?.expiresAt), String(r.data?.expiresAt));

  const v = await viewJson(docToken);
  check('the recipient gets the scans', (v.body?.documents ?? []).length === 2, `${v.body?.documents?.length}`);
  check(
    'each with a short-lived URL rather than a durable one',
    (v.body?.documents ?? []).every((d) => !d.fileUrl || /token=/.test(d.fileUrl)),
    ''
  );
  check(
    'but never a document number, at any setting',
    !/PA1234567|PB7654321/.test(JSON.stringify(v.body)),
    ''
  );

  // The scoping difference between the two mechanisms, stated as a test: a
  // linked member sees only their own documents; a share recipient the
  // organizer trusted with this link sees the trip's. Two mechanisms, two
  // answers, on purpose.
  check(
    'a share recipient sees the whole trip’s documents, unlike a linked member',
    (v.body?.documents ?? []).length > 1
  );
}

console.log('\nA link that is edited, revoked, or was never real');
{
  const { error: editErr } = await organizer
    .from('share_links')
    .update({ includes_documents: true })
    .eq('token_hash', (await organizer.from('share_links').select('token_hash').limit(1)).data?.[0]?.token_hash ?? '');
  check('an existing link cannot be quietly upgraded to include documents', Boolean(editErr), editErr?.message ?? 'accepted!');

  const { data: links } = await organizer.from('share_links').select('id, revoked, expires_at, label, trip_id, includes_documents, created_at');
  const target = links.find((l) => l.label === 'The neighbour');

  await organizer.from('share_links').update({ revoked: true }).eq('id', target.id);
  const dead = await viewJson(plainToken);
  check('a revoked link stops working', dead.status === 404, `HTTP ${dead.status}`);

  const { error: unrevoke } = await organizer
    .from('share_links')
    .update({ revoked: false })
    .eq('id', target.id);
  check('and cannot be reinstated', Boolean(unrevoke), unrevoke?.message ?? 'accepted!');

  const bogus = await viewJson('z'.repeat(43));
  check(
    'a token that never existed reads exactly like a revoked one',
    bogus.body?.error === dead.body?.error,
    `${bogus.body?.error} vs ${dead.body?.error}`
  );

  // The wording the app would show for this link agrees with the database.
  check(
    'the app describes it as revoked too',
    describeShareLink({
      id: target.id,
      tripId: target.trip_id,
      label: target.label,
      includesDocuments: target.includes_documents,
      revoked: true,
      createdAt: target.created_at,
      expiresAt: target.expires_at,
    }).includes('revoked')
  );
}

console.log('\nThe anonymous endpoint is rate limited');
{
  await clearAttempts();

  let attempts = 0;
  let limitedAt = 0;
  for (let i = 0; i < 12 && !limitedAt; i++) {
    attempts += 1;
    const r = await viewJson('q'.repeat(43));
    if (r.status === 429) limitedAt = attempts;
  }
  check(
    'repeated bad tokens are eventually refused outright',
    limitedAt > 0,
    limitedAt ? `429 on attempt ${limitedAt}` : `still answering after ${attempts}`
  );

  // A real link keeps working for anyone who is not the one being throttled --
  // checked by clearing the counter, which is what time would otherwise do.
  await clearAttempts();
  const ok = await viewJson(docToken);
  check('and a good link still works once the window passes', ok.status === 200, `HTTP ${ok.status}`);

  const { data: logRows, error: attErr } = await other.from('share_link_attempts').select('id');
  check(
    'the attempt log is unreachable from any client',
    (logRows ?? []).length === 0,
    attErr?.code ?? `${logRows?.length} rows`
  );
}

console.log('\nThe database agrees with lib/tiers.ts about F9');
{
  // The same cross-check F8 gets, for the same reason: two encodings of one
  // rule drifting apart means the app and the database disagree about what
  // someone paid for.
  for (const feature of GATED_FEATURES) {
    for (const tier of TIERS) {
      const { data: dbAnswer } = await organizer.rpc('tier_has_feature', { t: tier, f: feature });
      if (dbAnswer !== hasFeature(tier, feature)) {
        check(`${tier}/${feature} agrees`, false, `db=${dbAnswer} app=${hasFeature(tier, feature)}`);
      }
    }
  }
  check(`all ${TIERS.length * GATED_FEATURES.length} tier/feature pairs agree with the database`, true);

  const { data: unknown } = await organizer.rpc('tier_has_feature', { t: 'family', f: 'visa_checker' });
  // F7 is deliberately not in this system at all; the database must not invent
  // an answer for it.
  check('an ungated feature is not silently granted', unknown === false, String(unknown));
}

console.log('\nCleanup');
{
  await fn(organizer, 'account', { action: 'delete', confirmation: 'DELETE' });

  const { data: gone } = await admin.from('travelers').select('id').eq('user_id', oUser.id);
  check('the organizer’s account and data are removed', (gone ?? []).length === 0, `${gone?.length}`);

  // The feature plan is explicit: a linked family member's own account is NOT
  // deleted with the organizer's. They are a separate account holder.
  const m2 = client();
  const { data: stillIn, error: signInErr } = await m2.auth.signInWithPassword({
    email: `tv-f9-mem-${stamp}@tripvault.local`,
    password: 'Test-passw0rd!M',
  });
  check(
    'the linked member’s own account survives the organizer’s deletion',
    Boolean(stillIn?.user) && !signInErr,
    signInErr?.message ?? ''
  );

  const { data: leftovers } = await admin
    .from('share_links')
    .select('id')
    .eq('created_by', oUser.id);
  check('and their share links went with them', (leftovers ?? []).length === 0, `${leftovers?.length}`);

  await admin.auth.admin.deleteUser(mUser.id).catch(() => {});
  await admin.auth.admin.deleteUser(xUser.id).catch(() => {});
  await clearAttempts();
}

console.log(`\n${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ''}\n`);
process.exit(fail === 0 ? 0 : 1);
