/**
 * Test support for F8's tier gate.
 *
 * Several verifiers need more than one traveler profile, which a Free account
 * cannot have — correctly, since Phase 6. Granting a test account a paid tier
 * needs the service role, because `subscriptions` deliberately has no client
 * write policy: an app that could set its own tier would make the whole feature
 * decorative.
 *
 * So elevation is OPTIONAL and explicit. Put the project's service role key in
 * `scripts/.service-key` (gitignored) or $SUPABASE_SERVICE_ROLE_KEY and the
 * multi-traveler sections run. Without it they SKIP with a visible notice
 * rather than failing, so a run without the key still proves everything it can.
 *
 * No test-only backdoor is added to the app for this. A tier-granting endpoint
 * guarded by a shared secret would be a real hole shipped to production for the
 * convenience of a test suite, which is a bad trade.
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';

const KEY_FILE = new URL('./.service-key', import.meta.url);

export const serviceKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  (existsSync(KEY_FILE) ? readFileSync(KEY_FILE, 'utf8').trim() : '');

export const hasServiceKey = Boolean(serviceKey);

export const NO_KEY_NOTICE =
  '  SKIP  needs a paid tier — put the service role key in scripts/.service-key to run this';

/**
 * Grant a test account a tier. Returns false when no service key is available,
 * which the caller should treat as "skip", not "fail".
 */
export async function grantTier(supabaseUrl, userId, tier, expiresAt = null) {
  if (!hasServiceKey) return false;

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { error } = await admin.from('subscriptions').upsert(
    {
      user_id: userId,
      tier,
      source: 'manual',
      expires_at: tier === 'lifetime' || tier === 'free' ? null : expiresAt,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id' }
  );

  if (error) throw new Error(`could not grant ${tier}: ${error.message}`);
  return true;
}
