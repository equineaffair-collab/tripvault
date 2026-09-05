/**
 * F1 verification — exercises the document vault against the live project,
 * covering the parts that only exist once the Edge Function is deployed:
 * the encryption round trip, the closed write path, the guardian gate, minor
 * data minimization, cross-account isolation and the audit log.
 *
 *   node scripts/verify-f1.mjs
 *
 * Requires "Confirm email" to be OFF in Supabase Auth settings so the script
 * can sign its two throwaway users straight in. Turn it back on afterwards.
 */
import { createClient } from '@supabase/supabase-js';
import { grantTier, hasServiceKey } from './_tier.mjs';
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

const PASSPORT_NUMBER = 'L898902C3';
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

/** Call the documents Edge Function, returning { data, error, status }. */
async function fn(c, body) {
  const { data, error } = await c.functions.invoke('documents', { body });
  if (!error) return { data, error: null, status: 200 };
  const res = error.context;
  const payload = res && typeof res.json === 'function' ? await res.json().catch(() => null) : null;
  return { data: null, error: payload ?? { error: error.message }, status: res?.status ?? 0 };
}

console.log('\nF1 — document vault\n');

const a = client();
const b = client();
const aUser = await signUpAndIn(a, {
  email: `tv-f1-a-${stamp}@tripvault.local`,
  password: 'Test-passw0rd!A',
});
const bUser = await signUpAndIn(b, {
  email: `tv-f1-b-${stamp}@tripvault.local`,
  password: 'Test-passw0rd!B',
});

const mk = async (c, user, name, relationship) => {
  const { data, error } = await c
    .from('travelers')
    .insert({ user_id: user.id, name, relationship })
    .select('id, is_minor')
    .single();
  if (error) throw new Error(`could not create traveler: ${error.message}`);
  return data;
};

// F1 needs an adult and a minor profile on the same account, which is two
// profiles -- more than Free allows since Phase 6. Grant the test account
// Family so the guardian-gate checks can run at all.
await grantTier(URL_, aUser.id, 'family');
if (!hasServiceKey) {
  console.error('');
  console.error('  This verifier needs an adult and a minor profile, which a Free account cannot have.');
  console.error('  Put the service role key in scripts/.service-key and re-run.');
  console.error('');
  process.exit(2);
}

const adult = await mk(a, aUser, `F1 adult ${stamp}`, 'self');
const child = await mk(a, aUser, `F1 child ${stamp}`, 'child');
const bTraveler = await mk(b, bUser, `F1 other ${stamp}`, 'self');
console.log(`  (adult ${adult.id.slice(0, 8)}…, child ${child.id.slice(0, 8)}… is_minor=${child.is_minor})\n`);

console.log('Encryption round trip');
let docId = null;
{
  const { data, error } = await fn(a, {
    action: 'create',
    travelerId: adult.id,
    type: 'passport',
    country: 'AUS',
    documentNumber: PASSPORT_NUMBER,
    issueDate: '2022-01-15',
    expiryDate: '2032-01-15',
    isPrimary: true,
  });
  check('a document can be created through the Edge Function', !error, error?.error ?? '');
  docId = data?.document?.id ?? null;
  check('the response never carries the number back', JSON.stringify(data ?? {}).indexOf(PASSPORT_NUMBER) === -1);
}

if (docId) {
  const { data: row } = await a
    .from('documents')
    .select('document_number_encrypted, issue_date, is_primary, country')
    .eq('id', docId)
    .single();

  check('what is stored is not the plaintext number', !String(row?.document_number_encrypted).includes(PASSPORT_NUMBER));
  check(
    'what is stored is a versioned envelope',
    /^v\d+\.[A-Za-z0-9+/]+=*\.[A-Za-z0-9+/]+=*$/.test(row?.document_number_encrypted ?? ''),
    String(row?.document_number_encrypted).slice(0, 24) + '…'
  );
  check('an adult profile keeps its issue date', row?.issue_date === '2022-01-15', String(row?.issue_date));

  const { data: dec, error: decErr } = await fn(a, { action: 'decrypt', documentId: docId });
  check('the owner can decrypt it back to the original', dec?.documentNumber === PASSPORT_NUMBER, decErr?.error ?? String(dec?.documentNumber));
}

console.log('\nThe write path is closed to the client');
{
  const { error } = await a.from('documents').insert({
    traveler_id: adult.id,
    type: 'visa',
    document_number_encrypted: 'v1.AAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBB',
  });
  check('a direct INSERT is refused by RLS', Boolean(error), error?.code ?? 'accepted');
}
if (docId) {
  const { data } = await a
    .from('documents')
    .update({ document_number_encrypted: 'v1.AAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBB' })
    .eq('id', docId)
    .select();
  check('a direct UPDATE changes nothing', (data ?? []).length === 0);

  // The number must still decrypt, proving the update above really was a no-op.
  const { data: dec } = await fn(a, { action: 'decrypt', documentId: docId });
  check('the stored number survived the attempted overwrite', dec?.documentNumber === PASSPORT_NUMBER);
}
{
  const { error } = await a
    .from('document_access_log')
    .insert({ document_id: docId, actor_user_id: aUser.id, action: 'decrypt' });
  check('the audit log cannot be written from the client', Boolean(error), error?.code ?? 'accepted');
}

console.log("\nF1's guardian gate on a minor profile");
{
  const { error, status } = await fn(a, {
    action: 'create',
    travelerId: child.id,
    type: 'passport',
    country: 'AUS',
    documentNumber: 'C123456',
    issueDate: '2022-05-05',
    expiryDate: '2030-05-05',
  });
  check('a minor document is blocked without acknowledgment', status === 403, `HTTP ${status}`);
  check('the block is machine-readable, so the app can prompt', error?.code === 'GUARDIAN_ACKNOWLEDGEMENT_REQUIRED', error?.code ?? '');
}
{
  const { data, error } = await fn(a, {
    action: 'create',
    travelerId: child.id,
    type: 'passport',
    country: 'AUS',
    documentNumber: 'C123456',
    issueDate: '2022-05-05',
    expiryDate: '2030-05-05',
    guardianAcknowledged: true,
  });
  check('it succeeds once acknowledged', !error, error?.error ?? '');
  check('minor data minimization drops the issue date', data?.document?.issue_date === null, String(data?.document?.issue_date));

  const { data: t } = await a
    .from('travelers')
    .select('guardian_acknowledged_at')
    .eq('id', child.id)
    .single();
  check('the acknowledgment is recorded on the profile', Boolean(t?.guardian_acknowledged_at), String(t?.guardian_acknowledged_at));
}

console.log('\nCross-account isolation');
if (docId) {
  const { error, status } = await fn(b, { action: 'decrypt', documentId: docId });
  check("user B cannot decrypt user A's document", status === 404, `HTTP ${status} ${error?.error ?? ''}`);

  const { data } = await b.from('documents').select('id').eq('id', docId);
  check("user B cannot even read the ciphertext row", (data ?? []).length === 0);

  const { error: plantErr } = await fn(b, {
    action: 'create',
    travelerId: adult.id,
    type: 'visa',
    documentNumber: 'HACK1',
  });
  check("user B cannot attach a document to user A's traveler", Boolean(plantErr), plantErr?.error ?? 'accepted');
}

console.log('\nAudit log');
{
  const { data } = await a
    .from('document_access_log')
    .select('action, succeeded')
    .eq('actor_user_id', aUser.id);
  const actions = (data ?? []).map((r) => r.action);
  check('creates are logged', actions.includes('create'), actions.join(',') || 'none');
  check('decrypts are logged', actions.includes('decrypt'), actions.join(',') || 'none');

  const { data: bLog } = await b.from('document_access_log').select('id').eq('actor_user_id', aUser.id);
  check("user B cannot read user A's access history", (bLog ?? []).length === 0);
}

console.log('\nCascade');
{
  await a.from('travelers').delete().eq('id', adult.id);
  const { data } = await a.from('documents').select('id').eq('traveler_id', adult.id);
  check('deleting a traveler removes their documents', (data ?? []).length === 0);
}

console.log('\nCleanup');
{
  await a.from('travelers').delete().eq('user_id', aUser.id);
  await b.from('travelers').delete().eq('user_id', bUser.id);
  const { data } = await a.from('travelers').select('id').eq('user_id', aUser.id);
  check('test travelers removed', (data ?? []).length === 0);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
