/**
 * F2 verification — expiry reminders, against the live project.
 *
 *   node scripts/verify-f2.mjs
 *
 * The test plan's F2 section asks for each milestone to fire the right channel
 * combination, and for email to be un-disableable. Waiting six months for a
 * real trigger is not a test, so the sweep accepts a pinned `today` and this
 * walks a single document through all three milestones by moving that date.
 *
 * Requires:
 *   - "Confirm email" OFF in Supabase Auth settings
 *   - the sweep's secret, in scripts/.sweep-secret or $REMINDER_SWEEP_SECRET
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => l.trim() && !l.trim().startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    })
);

const SECRET_FILE = new URL('./.sweep-secret', import.meta.url);
const SWEEP_SECRET =
  process.env.REMINDER_SWEEP_SECRET ??
  (existsSync(SECRET_FILE) ? readFileSync(SECRET_FILE, 'utf8').trim() : '');

if (!SWEEP_SECRET) {
  console.error(
    '\nNo sweep secret.\n' +
      '  Put it in scripts/.sweep-secret (gitignored) or set REMINDER_SWEEP_SECRET.\n' +
      '  It is the value passed to `supabase secrets set REMINDER_SWEEP_SECRET=...`.\n'
  );
  process.exit(2);
}

const BASE = env.EXPO_PUBLIC_SUPABASE_URL;
const client = () =>
  createClient(BASE, env.EXPO_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });

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

/** Invoke the sweep with a pinned date. */
async function sweep(today) {
  const res = await fetch(`${BASE}/functions/v1/reminder-sweep`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: env.EXPO_PUBLIC_SUPABASE_ANON_KEY,
      'x-sweep-secret': SWEEP_SECRET,
    },
    body: JSON.stringify({ today }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

console.log('\nF2 — expiry reminders\n');

const a = client();
const aUser = await signUpAndIn(a, {
  email: `tv-f2-${stamp}@tripvault.local`,
  password: 'Test-passw0rd!F2',
});

// A passport expiring on a fixed date, so every milestone is computable.
const EXPIRY = '2027-06-15';
const { data: trav } = await a
  .from('travelers')
  .insert({ user_id: aUser.id, name: `F2 traveler ${stamp}`, relationship: 'self' })
  .select('id')
  .single();

const { data: docResp } = await a.functions.invoke('documents', {
  body: {
    action: 'create',
    travelerId: trav.id,
    type: 'passport',
    country: 'AUS',
    documentNumber: `F2${stamp}`,
    expiryDate: EXPIRY,
  },
});
const documentId = docResp?.document?.id;
check('a document with a known expiry exists', Boolean(documentId), EXPIRY);

const remindersFor = async () => {
  const { data } = await a
    .from('reminders')
    .select('milestone, channels, sent, superseded, acknowledged')
    .eq('ref_id', documentId)
    .order('milestone', { ascending: false });
  return data ?? [];
};

console.log('\nThe sweep is guarded');
{
  const res = await fetch(`${BASE}/functions/v1/reminder-sweep`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: env.EXPO_PUBLIC_SUPABASE_ANON_KEY },
    body: '{}',
  });
  check('an unauthenticated sweep is refused', res.status === 401, `HTTP ${res.status}`);
}

console.log('\nNothing fires before the first milestone');
{
  const { status } = await sweep('2026-06-01');
  check('the sweep runs', status === 200, `HTTP ${status}`);
  const rows = await remindersFor();
  check('no reminder yet, 12 months out', rows.length === 0, `${rows.length} rows`);
}

console.log('\nSix months out — email only');
{
  await sweep('2026-12-15');
  const rows = await remindersFor();
  const six = rows.find((r) => r.milestone === 6);
  check('a six-month reminder exists', Boolean(six));
  check('its channel is email only', JSON.stringify(six?.channels) === '["email"]', JSON.stringify(six?.channels));
}

console.log('\nRe-running the same day does not duplicate');
{
  await sweep('2026-12-15');
  const rows = await remindersFor();
  check('still exactly one reminder', rows.length === 1, `${rows.length} rows`);
}

console.log('\nThree months out — email and push');
{
  await sweep('2027-03-15');
  const rows = await remindersFor();
  const three = rows.find((r) => r.milestone === 3);
  check('a three-month reminder exists', Boolean(three));
  check(
    'its channels are email and push',
    JSON.stringify(three?.channels) === '["email","push"]',
    JSON.stringify(three?.channels)
  );
}

console.log('\nOne month out — email, push and a persistent banner');
{
  await sweep('2027-05-15');
  const rows = await remindersFor();
  const one = rows.find((r) => r.milestone === 1);
  check('a one-month reminder exists', Boolean(one));
  check(
    'its channels are email, push and banner',
    JSON.stringify(one?.channels) === '["email","push","banner"]',
    JSON.stringify(one?.channels)
  );
  check('all three milestones are now recorded', rows.length === 3, `${rows.length} rows`);
}

console.log('\nThe banner persists until acknowledged');
{
  const { data: before } = await a
    .from('reminders')
    .select('id, acknowledged')
    .eq('ref_id', documentId)
    .eq('milestone', 1)
    .single();
  check('the banner starts unacknowledged', before?.acknowledged === false);

  await a.from('reminders').update({ acknowledged: true }).eq('id', before.id);
  const { data: after } = await a
    .from('reminders')
    .select('acknowledged')
    .eq('id', before.id)
    .single();
  check('it can be acknowledged, and that is stored server-side', after?.acknowledged === true);
}

console.log('\nEmail cannot be switched off');
{
  // The structural check: there is no email toggle to find, because the column
  // does not exist. A flag we agreed to ignore would be one refactor from being
  // honoured; a missing column cannot be.
  const { error } = await a
    .from('notification_preferences')
    .upsert({ user_id: aUser.id, email_enabled: false });
  check('there is no email_enabled column to set', Boolean(error), error?.code ?? 'accepted!');

  await a.from('notification_preferences').upsert({ user_id: aUser.id, push_enabled: false });
  const { data } = await a.from('notification_preferences').select('push_enabled').single();
  check('push, by contrast, can be turned off', data?.push_enabled === false);
}

console.log('\nWith push off, a new milestone still emails');
{
  const { data: doc2 } = await a.functions.invoke('documents', {
    body: {
      action: 'create',
      travelerId: trav.id,
      type: 'id_card',
      country: 'AUS',
      documentNumber: `F2B${stamp}`,
      expiryDate: '2027-09-15',
    },
  });
  await sweep('2027-06-15'); // three months before 2027-09-15
  const { data } = await a
    .from('reminders')
    .select('milestone, channels')
    .eq('ref_id', doc2?.document?.id);
  const three = (data ?? []).find((r) => r.milestone === 3);
  check(
    'the three-month reminder drops push but keeps email',
    JSON.stringify(three?.channels) === '["email"]',
    JSON.stringify(three?.channels)
  );
}

console.log('\nA late-added document sends one notice, not three');
{
  const { data: doc3 } = await a.functions.invoke('documents', {
    body: {
      action: 'create',
      travelerId: trav.id,
      type: 'passport',
      country: 'LVA',
      documentNumber: `F2C${stamp}`,
      expiryDate: '2027-07-01',
    },
  });
  // Sweeping three weeks before expiry: all three trigger dates have passed.
  await sweep('2027-06-10');
  const { data } = await a
    .from('reminders')
    .select('milestone, channels, superseded')
    .eq('ref_id', doc3?.document?.id);

  const rows = data ?? [];
  const live = rows.filter((r) => !r.superseded);
  check('exactly one live reminder', live.length === 1, `${live.length} live of ${rows.length}`);
  check('and it is the most urgent one', live[0]?.milestone === 1, String(live[0]?.milestone));
  check('the overtaken milestones are recorded as superseded', rows.filter((r) => r.superseded).length === 2);
}

console.log('\nReminders are not writable from the client');
{
  const { error } = await a.from('reminders').insert({
    user_id: aUser.id,
    ref_type: 'document',
    ref_id: documentId,
    milestone: 6,
    remind_at: '2027-01-01',
  });
  // A client that could insert could mark a milestone handled without sending.
  check('a direct insert is refused', Boolean(error), error?.code ?? 'accepted!');
}

console.log('\nCleanup');
{
  await a.from('travelers').delete().eq('user_id', aUser.id);
  const { data } = await a.from('reminders').select('id').eq('ref_id', documentId);
  check('reminders go with the document', (data ?? []).length === 0);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
