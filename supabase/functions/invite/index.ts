/**
 * F9 mechanism 1 — the linked login.
 *
 * A traveler profile the organizer already owns gains its own auth user, and
 * from then on every trip that profile attends simply appears for them. This
 * function exists for the two steps a client genuinely cannot take:
 *
 *   create — mint the invite code. Deno has a CSPRNG and SHA-256; React Native
 *            has neither without new native dependencies.
 *   accept — write `travelers.linked_auth_user_id`. The person accepting has no
 *            rights over the organizer's rows at all, and the database refuses
 *            that write from any client (see 0010's check_traveler_link), so it
 *            can only come from the service role after a real invite is
 *            presented.
 *
 * Everything else is ordinary RLS: listing invites, and revoking (which is a
 * client-side clear of the link, deliberately -- revoking access must never be
 * the operation that needs a server to be reachable).
 *
 * This is NOT the share-link path. That is `shared-trip`, a separate function
 * with a separate security model, and the two never call each other.
 *
 * Deploy:
 *   supabase functions deploy invite
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import { generateToken, hashToken, normaliseToken } from '../_shared/tokens.ts';

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

/** How long an unaccepted invite stays live. */
const DEFAULT_EXPIRY_DAYS = 14;
const MAX_EXPIRY_DAYS = 30;

/**
 * One message for every way an invite can fail to be usable.
 *
 * Expired, already accepted, revoked and never-existed are deliberately
 * indistinguishable from outside. Telling them apart would confirm to whoever
 * is holding a code that it was once real, which is the only thing a stranger
 * with a wrong code could usefully learn.
 */
const BAD_CODE = 'That invite code is not valid. Ask for a new one.';

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Use POST.' }, 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');

  if (!supabaseUrl || !serviceRoleKey || !anonKey) {
    console.error('invite function is misconfigured');
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

  try {
    if (body.action === 'create') {
      return await handleCreate({ supabaseUrl, anonKey, jwt, userId, body });
    }
    if (body.action === 'accept') {
      return await handleAccept(admin, userId, body);
    }
    return json({ error: 'Unknown action.' }, 400);
  } catch (e) {
    console.error('invite function failed', e);
    return json({ error: 'Something went wrong.' }, 500);
  }
});

/**
 * Mint an invite for one of the caller's own traveler profiles.
 *
 * The insert runs as the CALLER, not the service role, on purpose: ownership,
 * the Family-tier gate, the minor guard and the one-pending-invite rule all
 * live in the database, and running as the caller is what makes them apply.
 * Doing this with the service role would quietly bypass every one of them.
 */
async function handleCreate(args: {
  supabaseUrl: string;
  anonKey: string;
  jwt: string;
  userId: string;
  body: Record<string, unknown>;
}): Promise<Response> {
  const travelerId = args.body.travelerId;
  if (typeof travelerId !== 'string' || !travelerId) {
    return json({ error: 'Which traveler profile?' }, 400);
  }

  const requested = Number(args.body.expiresInDays ?? DEFAULT_EXPIRY_DAYS);
  const days =
    Number.isFinite(requested) && requested >= 1
      ? Math.min(Math.floor(requested), MAX_EXPIRY_DAYS)
      : DEFAULT_EXPIRY_DAYS;

  const asUser = createClient(args.supabaseUrl, args.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${args.jwt}` } },
  });

  const token = generateToken();
  const expiresAt = new Date(Date.now() + days * 86_400_000).toISOString();

  const { data, error } = await asUser
    .from('traveler_invites')
    .insert({
      traveler_id: travelerId,
      created_by: args.userId,
      token_hash: await hashToken(token),
      expires_at: expiresAt,
    })
    .select('id, expires_at')
    .single();

  if (error) {
    // The database's own wording is the useful wording here -- it names the
    // tier, the minor guard or the existing link specifically.
    return json({ error: error.message }, 400);
  }

  // The only time the raw code exists outside the recipient's hands. It is not
  // logged, not stored, and cannot be shown again.
  return json({ inviteId: data.id, code: token, expiresAt: data.expires_at });
}

/**
 * Accept an invite as the signed-in recipient.
 *
 * The recipient signs up normally first -- they are a genuine account holder in
 * their own right, which the ToS section of the feature plan is explicit about
 * -- and then presents the code.
 *
 * No rate limit here, unlike the share link: this endpoint requires a session,
 * so abuse is attributable to an account, and a 256-bit code is not something a
 * caller guesses their way into. The anonymous endpoint is the one that needs a
 * limit, and it has one.
 */
async function handleAccept(
  admin: ReturnType<typeof createClient>,
  userId: string,
  body: Record<string, unknown>
): Promise<Response> {
  const code = normaliseToken(body.code);
  if (!code) return json({ error: BAD_CODE }, 404);

  const { data: invite } = await admin
    .from('traveler_invites')
    .select('id, traveler_id, created_by, expires_at, accepted_at')
    .eq('token_hash', await hashToken(code))
    .maybeSingle();

  if (!invite) return json({ error: BAD_CODE }, 404);
  if (invite.accepted_at) return json({ error: BAD_CODE }, 404);
  if (Date.parse(invite.expires_at) <= Date.now()) return json({ error: BAD_CODE }, 404);

  if (invite.created_by === userId) {
    // Worth its own message: this one is a mistake, not an attack, and the
    // generic wording would send someone hunting for a broken code.
    return json({ error: 'That is your own invite. Send it to the person it is for.' }, 400);
  }

  const { data: traveler } = await admin
    .from('travelers')
    .select('id, name, is_minor, linked_auth_user_id, user_id')
    .eq('id', invite.traveler_id)
    .maybeSingle();

  if (!traveler) return json({ error: BAD_CODE }, 404);

  // Re-checked at acceptance, not just at creation. An invite can sit unused
  // for two weeks, and the profile may have been linked to someone else or
  // changed to a child in the meantime.
  if (traveler.linked_auth_user_id) {
    return json({ error: 'That profile already has its own login.' }, 409);
  }
  if (traveler.is_minor) {
    return json({ error: BAD_CODE }, 404);
  }
  if (traveler.user_id === userId) {
    return json({ error: 'That is your own traveler profile.' }, 400);
  }

  // One account, one profile. Without this a single login could accumulate
  // read access to several unrelated organizers' trips, which is a shape
  // nothing in F9 asks for and a lot of it assumes cannot happen.
  const { count: alreadyLinked } = await admin
    .from('travelers')
    .select('id', { count: 'exact', head: true })
    .eq('linked_auth_user_id', userId);

  if ((alreadyLinked ?? 0) > 0) {
    return json(
      { error: 'This login is already linked to a traveler profile. Use a different account.' },
      409
    );
  }

  const { error: linkError } = await admin
    .from('travelers')
    .update({ linked_auth_user_id: userId })
    .eq('id', traveler.id)
    .is('linked_auth_user_id', null); // lost-race guard

  if (linkError) {
    console.error('invite accept: link failed', linkError);
    return json({ error: 'Could not accept that invite.' }, 500);
  }

  // Marked used only after the link is written. If this second write fails the
  // invite stays open, which re-runs harmlessly; the reverse order could burn a
  // code that never granted anything.
  const { error: markError } = await admin
    .from('traveler_invites')
    .update({ accepted_at: new Date().toISOString(), accepted_by: userId })
    .eq('id', invite.id);

  if (markError) console.error('invite accept: could not mark used', markError);

  return json({ travelerId: traveler.id, travelerName: traveler.name });
}
