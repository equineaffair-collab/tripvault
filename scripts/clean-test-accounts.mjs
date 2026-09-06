/**
 * Remove the throwaway accounts the verifiers leave behind.
 *
 *   node scripts/clean-test-accounts.mjs          # show what would go
 *   node scripts/clean-test-accounts.mjs --delete # actually remove them
 *
 * Every verifier signs up one or more `tv-…@tripvault.local` accounts and
 * deletes its own rows afterwards, but until 2026-09-06 none of them could
 * delete the auth USER — that needs the service role, which was not available.
 * 130 of them had accumulated before anyone looked.
 *
 * Deleting the data but not the account is not harmless bookkeeping: an auth
 * user is a real credential row, and a project's user count is one of the few
 * numbers anyone glances at to sanity-check that something has not gone wrong.
 * A list that is 99% test noise is a list nobody reads.
 *
 * Deliberately conservative about what it will touch:
 *   - only the `@tripvault.local` domain, which Supabase would not accept for a
 *     real signup and which nothing but these scripts uses
 *   - only the `tv-` prefix the verifiers use
 *   - never `emu-test-…`, the hand-made account used for device testing
 *   - dry run unless --delete is passed
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { hasServiceKey, serviceKey } from './_tier.mjs';

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => l.trim() && !l.trim().startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    })
);

// Safe to exit here: nothing has opened a connection yet.
if (!hasServiceKey) {
  console.log('\nNeeds the service role key. Put it in scripts/.service-key.\n');
  process.exit(1);
}

const admin = createClient(env.EXPO_PUBLIC_SUPABASE_URL, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/** What a verifier account looks like, and nothing else. */
const isVerifierAccount = (email) =>
  typeof email === 'string' &&
  email.endsWith('@tripvault.local') &&
  /^tv-/.test(email) &&
  !email.startsWith('emu-test-');

const users = [];
for (let page = 1; ; page++) {
  const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
  if (error) throw new Error(error.message);
  users.push(...(data.users ?? []));
  if ((data.users ?? []).length < 1000) break;
}

const doomed = users.filter((u) => isVerifierAccount(u.email));
const keeping = users.length - doomed.length;

console.log(`\n${users.length} accounts — ${doomed.length} left by verifiers, ${keeping} kept.\n`);

for (const u of users.filter((x) => !isVerifierAccount(x.email))) {
  console.log(`  keep    ${u.email}`);
}

// No process.exit() past this point, and none above it either. The Supabase
// client holds a live libuv handle, and calling exit() on top of it makes Node
// abort on Windows with `UV_HANDLE_CLOSING` — which reads like a crash in a
// script whose entire job is tidying up, and would be believed. Letting Node
// finish on its own exits cleanly; setting process.exitCode still sets the code.
if (doomed.length === 0) {
  console.log('\nNothing to remove.\n');
} else if (!process.argv.includes('--delete')) {
  console.log(`\n  would remove ${doomed.length} accounts. Re-run with --delete to do it.\n`);
} else {
  let removed = 0;
  for (const u of doomed) {
    const { error } = await admin.auth.admin.deleteUser(u.id);
    if (error) console.warn(`  could not remove ${u.email}: ${error.message}`);
    else removed++;
  }
  console.log(`\nRemoved ${removed} of ${doomed.length}.\n`);
}
