/**
 * F5 — the in-app half of smart import (Path A), plus the forwarding address.
 *
 * Actions (POST, JSON body, authenticated):
 *   address {}                  -> the caller's forwarding address, creating one if needed
 *   rotate  {}                  -> replace it; the old one stops working immediately
 *   extract { text, tripId? }   -> read booking text and return the fields, unsaved
 *
 * `extract` deliberately returns the extraction rather than writing it. F5 is
 * explicit that the form pre-fills and the user confirms or corrects before it
 * is saved -- the same shape F1 uses for a scanned passport, and for the same
 * reason: a model's reading of a document is a draft, not a record.
 *
 * The forwarding address is minted here because it must come from a CSPRNG the
 * client does not have, and must not be chosen by the caller. There is no
 * INSERT or UPDATE policy on `forwarding_addresses` for exactly that reason.
 *
 * Deploy:
 *   supabase functions deploy smart-import
 */
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { extractBooking, isExtractionConfigured } from '../_shared/extraction.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

/** Where forwarded mail is received. Set once the inbound domain is live. */
function inboundDomain(): string {
  return Deno.env.get('INBOUND_EMAIL_DOMAIN') ?? '';
}

/**
 * 24 characters from a 32-symbol alphabet: about 120 bits.
 *
 * The alphabet excludes nothing for readability, on purpose -- nobody types
 * this address, they copy it, and shrinking the alphabet to avoid confusable
 * characters would only shrink the entropy of a credential.
 */
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

function newLocalPart(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  let out = 'tv';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Use POST.' }, 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceRoleKey) {
    console.error('smart-import function is misconfigured');
    return json({ error: 'Server is misconfigured.' }, 500);
  }

  const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!jwt) return json({ error: 'Not authenticated.' }, 401);

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: userData, error: userError } = await admin.auth.getUser(jwt);
  if (userError || !userData.user) return json({ error: 'Not authenticated.' }, 401);
  const userId = userData.user.id;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  // The tier gate applies to every action here. It is also enforced on the
  // write itself (0011's trigger), which is the check that actually holds --
  // this one exists so the refusal arrives with a sentence rather than a
  // constraint violation.
  const { data: tier } = await admin.rpc('current_tier', { uid: userId });
  const { data: allowed } = await admin.rpc('tier_has_feature', {
    t: tier ?? 'free',
    f: 'smart_import',
  });

  if (!allowed) {
    return json(
      {
        error: 'Smart import is part of Pro. Bookings can still be added by hand on any plan.',
        code: 'TIER_REQUIRED',
      },
      403
    );
  }

  try {
    if (body.action === 'address') return await handleAddress(admin, userId, false);
    if (body.action === 'rotate') return await handleAddress(admin, userId, true);
    if (body.action === 'extract') return await handleExtract(body);
    return json({ error: 'Unknown action.' }, 400);
  } catch (e) {
    console.error('smart-import function failed', e);
    return json({ error: 'Something went wrong.' }, 500);
  }
});

async function handleAddress(
  admin: SupabaseClient,
  userId: string,
  rotate: boolean
): Promise<Response> {
  const domain = inboundDomain();

  const { data: existing } = await admin
    .from('forwarding_addresses')
    .select('local_part, created_at, rotated_at')
    .eq('user_id', userId)
    .maybeSingle();

  if (existing && !rotate) {
    return json({
      localPart: existing.local_part,
      domain,
      configured: Boolean(domain),
      createdAt: existing.created_at,
      rotatedAt: existing.rotated_at,
    });
  }

  // Rotation replaces the row rather than keeping history. An old address kept
  // anywhere is an old credential kept anywhere, and the whole reason to rotate
  // is that the previous one should stop existing.
  const localPart = newLocalPart();
  const { data, error } = await admin
    .from('forwarding_addresses')
    .upsert(
      {
        user_id: userId,
        local_part: localPart,
        ...(existing ? { rotated_at: new Date().toISOString() } : {}),
      },
      { onConflict: 'user_id' }
    )
    .select('local_part, created_at, rotated_at')
    .single();

  if (error) {
    console.error('could not issue a forwarding address', error);
    return json({ error: 'Could not create a forwarding address.' }, 500);
  }

  return json({
    localPart: data.local_part,
    domain,
    configured: Boolean(domain),
    createdAt: data.created_at,
    rotatedAt: data.rotated_at,
  });
}

async function handleExtract(body: Record<string, unknown>): Promise<Response> {
  const text = typeof body.text === 'string' ? body.text : '';
  if (!text.trim()) return json({ error: 'There was nothing to read.' }, 400);

  const outcome = await extractBooking(text);

  if (outcome.status === 'unconfigured') {
    // 501, not 500: this is a thing the server does not do yet, not a thing
    // that went wrong. The app shows the manual form and says so.
    return json({ error: outcome.detail, code: 'EXTRACTION_UNAVAILABLE' }, 501);
  }
  if (outcome.status === 'unreadable') {
    return json({ error: outcome.detail, code: 'UNREADABLE' }, 422);
  }
  if (outcome.status === 'failed') {
    return json({ error: outcome.detail, code: 'EXTRACTION_FAILED' }, 502);
  }

  return json({ booking: outcome.booking, configured: isExtractionConfigured() });
}
