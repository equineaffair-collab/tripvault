/**
 * F12 — data export and account deletion.
 *
 * Both actions live server-side for the same reason: they need to reach data
 * the client cannot. Export must decrypt document numbers, which requires the
 * key that only an Edge Function holds. Deletion must remove the auth user
 * itself, which requires the service role.
 *
 * Deploy:
 *   supabase functions deploy account
 * (Reuses DOCUMENT_ENCRYPTION_KEY, already set for the documents function.)
 *
 * Actions (POST, JSON body):
 *   export  {}                      -> the full account package
 *   delete  { confirmation: "DELETE" }
 */
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { decryptDocumentNumber, importKey } from '../_shared/crypto.ts';

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

/**
 * How recently the caller must have authenticated for an export.
 *
 * F12 requires re-authentication immediately beforehand, because an export is
 * effectively a full sensitive-data dump. Rather than invent a second login
 * flow, this checks the age of the session's own auth_time: the app signs the
 * user in again and retries, which produces a fresh token.
 */
const REAUTH_WINDOW_SECONDS = 5 * 60;

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Use POST.' }, 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const encryptionKey = Deno.env.get('DOCUMENT_ENCRYPTION_KEY');

  if (!supabaseUrl || !serviceRoleKey || !encryptionKey) {
    console.error('account function is misconfigured');
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
    if (body.action === 'export') return await handleExport(admin, jwt, userId, encryptionKey);
    if (body.action === 'delete') return await handleDelete(admin, userId, body);
    return json({ error: 'Unknown action.' }, 400);
  } catch (e) {
    console.error('account function failed', e);
    return json({ error: 'Something went wrong.' }, 500);
  }
});

/** Seconds since this token's authentication event, or null if not stated. */
function sessionAgeSeconds(jwt: string): number | null {
  try {
    const payload = JSON.parse(atob(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    const authTime = payload.auth_time ?? payload.iat;
    if (typeof authTime !== 'number') return null;
    return Math.floor(Date.now() / 1000) - authTime;
  } catch {
    return null;
  }
}

async function handleExport(
  admin: SupabaseClient,
  jwt: string,
  userId: string,
  encryptionKey: string
): Promise<Response> {
  const age = sessionAgeSeconds(jwt);
  if (age === null || age > REAUTH_WINDOW_SECONDS) {
    // F12's re-authentication requirement, enforced rather than assumed.
    return json(
      {
        error: 'Please log in again before exporting your data.',
        code: 'REAUTH_REQUIRED',
      },
      403
    );
  }

  const [travelers, trips, tripItems, checklist, loyalty, documents] = await Promise.all([
    admin.from('travelers').select('*').eq('user_id', userId),
    admin.from('trips').select('*').eq('user_id', userId),
    admin.from('trip_items').select('*').eq('user_id', userId),
    admin.from('trip_checklist_items').select('*, trips!inner(user_id)').eq('trips.user_id', userId),
    admin.from('loyalty_programs').select('*, travelers!inner(user_id)').eq('travelers.user_id', userId),
    admin.from('documents').select('*, travelers!inner(user_id)').eq('travelers.user_id', userId),
  ]);

  const key = await importKey(encryptionKey);

  // An export is for the person the data is about, so document numbers are
  // decrypted here. Storing them encrypted protects against a database breach,
  // not against the owner reading their own record.
  const documentsOut = [];
  for (const doc of documents.data ?? []) {
    let documentNumber: string | null = null;
    try {
      documentNumber = await decryptDocumentNumber(doc.document_number_encrypted, doc.id, key);
    } catch {
      documentNumber = null; // unreadable rather than omitted, so the gap is visible
    }
    const { document_number_encrypted: _drop, travelers: _t, ...rest } = doc;
    documentsOut.push({ ...rest, document_number: documentNumber });
  }

  const strip = (rows: Record<string, unknown>[] | null) =>
    (rows ?? []).map(({ travelers: _t, trips: _tr, ...rest }) => rest);

  return json({
    export: {
      format: 'tripvault-export-v1',
      generated_at: new Date().toISOString(),
      account: { id: userId, email: (await admin.auth.admin.getUserById(userId)).data.user?.email },
      travelers: travelers.data ?? [],
      documents: documentsOut,
      trips: trips.data ?? [],
      trip_items: tripItems.data ?? [],
      trip_checklist_items: strip(checklist.data),
      loyalty_programs: strip(loyalty.data),
    },
  });
}

async function handleDelete(
  admin: SupabaseClient,
  userId: string,
  body: Record<string, unknown>
): Promise<Response> {
  // Deliberate friction: deletion is irreversible and must not be one stray tap.
  if (body.confirmation !== 'DELETE') {
    return json({ error: 'Deletion requires an explicit confirmation.', code: 'CONFIRM_REQUIRED' }, 400);
  }

  // Storage objects are not covered by the database cascade -- a passport scan
  // would otherwise outlive the account that owned it.
  try {
    const { data: files } = await admin.storage.from('documents').list(userId, { limit: 1000 });
    const paths: string[] = [];
    for (const entry of files ?? []) {
      const { data: inner } = await admin.storage
        .from('documents')
        .list(`${userId}/${entry.name}`, { limit: 1000 });
      for (const f of inner ?? []) paths.push(`${userId}/${entry.name}/${f.name}`);
    }
    if (paths.length > 0) await admin.storage.from('documents').remove(paths);
  } catch (e) {
    console.error('storage cleanup failed', e);
  }

  // Everything else cascades from auth.users: travelers -> documents and
  // loyalty_programs; trips -> trip_items, trip_travelers, checklist items.
  // trip_items also references the user directly for F5's unassigned holding
  // area, and that FK cascades too.
  //
  // document_access_log deliberately does NOT cascade: its actor_user_id is
  // ON DELETE SET NULL, so the record that access happened survives the account.
  const { error } = await admin.auth.admin.deleteUser(userId);
  if (error) {
    console.error('account deletion failed', error);
    return json({ error: 'Could not delete the account.' }, 500);
  }

  return json({ deleted: true });
}
