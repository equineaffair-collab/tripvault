/**
 * F1 — the only code that holds the document encryption key.
 *
 * Every write of a document number, and every read of one in the clear, passes
 * through here. The app never sees the key and the database never sees the
 * plaintext, which is what makes a compromise of either one on its own
 * insufficient to expose passport numbers.
 *
 * Deploy:
 *   supabase functions deploy documents
 *   supabase secrets set DOCUMENT_ENCRYPTION_KEY="$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")"
 *
 * Actions (POST, JSON body, { action: ... }):
 *   create  { travelerId, type, country?, documentNumber, issueDate?, expiryDate?,
 *             isPrimary?, filePath?, guardianAcknowledged? }
 *   update  { documentId, ...same optional fields }
 *   decrypt { documentId }
 */
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';
import {
  CryptoError,
  decryptDocumentNumber,
  encryptDocumentNumber,
  importKey,
} from '../_shared/crypto.ts';

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

type Traveler = { id: string; user_id: string; is_minor: boolean; guardian_acknowledged_at: string | null };

/** Append to the audit log. Never allowed to fail the request it describes. */
async function log(
  admin: SupabaseClient,
  entry: { document_id: string | null; actor_user_id: string; action: string; succeeded: boolean }
): Promise<void> {
  try {
    await admin.from('document_access_log').insert(entry);
  } catch (e) {
    console.error('audit log write failed', e);
  }
}

/**
 * Resolve the traveler a request is about and confirm the caller owns it.
 * Read with the admin client but filtered on the caller's own id, so a missing
 * row and someone else's row are indistinguishable from outside.
 */
async function ownedTraveler(
  admin: SupabaseClient,
  travelerId: string,
  userId: string
): Promise<Traveler | null> {
  const { data } = await admin
    .from('travelers')
    .select('id, user_id, is_minor, guardian_acknowledged_at')
    .eq('id', travelerId)
    .eq('user_id', userId)
    .maybeSingle();
  return (data as Traveler | null) ?? null;
}

/**
 * F1: a minor's profile carries stricter data minimization -- capture only what
 * the feature functionally needs (type, number, expiry, country) and drop the
 * optional extras. Enforced here rather than left to the form, so it holds for
 * any caller.
 */
function minimizeForMinor<T extends { issueDate?: string | null }>(fields: T, isMinor: boolean): T {
  if (!isMinor) return fields;
  return { ...fields, issueDate: null };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Use POST.' }, 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const encryptionKey = Deno.env.get('DOCUMENT_ENCRYPTION_KEY');

  if (!supabaseUrl || !serviceRoleKey) {
    console.error('Supabase environment is not configured.');
    return json({ error: 'Server is misconfigured.' }, 500);
  }
  if (!encryptionKey) {
    // Fail closed. Running without the key would mean either writing plaintext
    // or silently losing the ability to read anything back.
    console.error('DOCUMENT_ENCRYPTION_KEY is not set.');
    return json({ error: 'Server is misconfigured.' }, 500);
  }

  const authHeader = req.headers.get('Authorization') ?? '';
  const jwt = authHeader.replace(/^Bearer\s+/i, '');
  if (!jwt) return json({ error: 'Not authenticated.' }, 401);

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: userData, error: userError } = await admin.auth.getUser(jwt);
  if (userError || !userData.user) return json({ error: 'Not authenticated.' }, 401);
  const userId = userData.user.id;

  let key: CryptoKey;
  try {
    key = await importKey(encryptionKey);
  } catch (e) {
    console.error('encryption key is unusable', e);
    return json({ error: 'Server is misconfigured.' }, 500);
  }

  let body: Record<string, any>;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Body must be JSON.' }, 400);
  }

  try {
    switch (body.action) {
      // ---------------------------------------------------------------- create
      case 'create': {
        const traveler = await ownedTraveler(admin, String(body.travelerId ?? ''), userId);
        if (!traveler) return json({ error: 'Traveler not found.' }, 404);

        // F1's parent/guardian gate. Enforced server-side, so it cannot be
        // skipped by calling the API directly rather than using the form.
        if (traveler.is_minor && !traveler.guardian_acknowledged_at) {
          if (body.guardianAcknowledged !== true) {
            return json(
              {
                error: 'This profile is a minor. A parent or guardian must confirm first.',
                code: 'GUARDIAN_ACKNOWLEDGEMENT_REQUIRED',
              },
              403
            );
          }
          // Recorded at the moment it is relied upon, not at signup.
          await admin
            .from('travelers')
            .update({ guardian_acknowledged_at: new Date().toISOString() })
            .eq('id', traveler.id)
            .eq('user_id', userId);
        }

        const documentNumber = String(body.documentNumber ?? '').trim();
        if (!documentNumber) return json({ error: 'A document number is required.' }, 400);

        // The id is generated here, before encryption, because it is bound into
        // the ciphertext as additional authenticated data.
        const documentId = crypto.randomUUID();
        const encrypted = await encryptDocumentNumber(documentNumber, documentId, key);

        const fields = minimizeForMinor(
          {
            issueDate: (body.issueDate as string | null) ?? null,
          },
          traveler.is_minor
        );

        const { data, error } = await admin
          .from('documents')
          .insert({
            id: documentId,
            traveler_id: traveler.id,
            type: body.type ?? 'passport',
            country: body.country ?? null,
            document_number_encrypted: encrypted,
            issue_date: fields.issueDate,
            expiry_date: (body.expiryDate as string | null) ?? null,
            is_primary: body.isPrimary === true,
            file_path: (body.filePath as string | null) ?? null,
          })
          .select('id, traveler_id, type, country, issue_date, expiry_date, is_primary, file_path, created_at')
          .single();

        if (error) {
          await log(admin, { document_id: documentId, actor_user_id: userId, action: 'create', succeeded: false });
          return json({ error: error.message }, 400);
        }

        await log(admin, { document_id: documentId, actor_user_id: userId, action: 'create', succeeded: true });
        return json({ document: data });
      }

      // ---------------------------------------------------------------- update
      case 'update': {
        const documentId = String(body.documentId ?? '');
        if (!documentId) return json({ error: 'A document id is required.' }, 400);

        const { data: existing } = await admin
          .from('documents')
          .select('id, traveler_id, travelers!inner(user_id, is_minor)')
          .eq('id', documentId)
          .eq('travelers.user_id', userId)
          .maybeSingle();

        if (!existing) return json({ error: 'Document not found.' }, 404);
        const isMinor = Boolean((existing as any).travelers?.is_minor);

        const patch: Record<string, unknown> = {};
        if (body.type !== undefined) patch.type = body.type;
        if (body.country !== undefined) patch.country = body.country;
        if (body.expiryDate !== undefined) patch.expiry_date = body.expiryDate;
        if (body.isPrimary !== undefined) patch.is_primary = body.isPrimary === true;
        if (body.filePath !== undefined) patch.file_path = body.filePath;
        if (body.issueDate !== undefined) {
          patch.issue_date = minimizeForMinor({ issueDate: body.issueDate }, isMinor).issueDate;
        }

        if (body.documentNumber !== undefined) {
          const next = String(body.documentNumber).trim();
          if (!next) return json({ error: 'A document number cannot be blank.' }, 400);
          // Re-encrypted under the same document id, so the binding still holds.
          patch.document_number_encrypted = await encryptDocumentNumber(next, documentId, key);
        }

        const { data, error } = await admin
          .from('documents')
          .update(patch)
          .eq('id', documentId)
          .select('id, traveler_id, type, country, issue_date, expiry_date, is_primary, file_path, created_at')
          .single();

        if (error) {
          await log(admin, { document_id: documentId, actor_user_id: userId, action: 'update', succeeded: false });
          return json({ error: error.message }, 400);
        }

        await log(admin, { document_id: documentId, actor_user_id: userId, action: 'update', succeeded: true });
        return json({ document: data });
      }

      // --------------------------------------------------------------- decrypt
      case 'decrypt': {
        const documentId = String(body.documentId ?? '');
        if (!documentId) return json({ error: 'A document id is required.' }, 400);

        // Ownership is re-checked here rather than trusted from the client:
        // this is the one call that returns a passport number in the clear.
        const { data: row } = await admin
          .from('documents')
          .select('id, document_number_encrypted, travelers!inner(user_id)')
          .eq('id', documentId)
          .eq('travelers.user_id', userId)
          .maybeSingle();

        if (!row) {
          await log(admin, { document_id: documentId, actor_user_id: userId, action: 'decrypt', succeeded: false });
          return json({ error: 'Document not found.' }, 404);
        }

        try {
          const documentNumber = await decryptDocumentNumber(
            (row as any).document_number_encrypted,
            documentId,
            key
          );
          await log(admin, { document_id: documentId, actor_user_id: userId, action: 'decrypt', succeeded: true });
          return json({ documentNumber });
        } catch (e) {
          await log(admin, { document_id: documentId, actor_user_id: userId, action: 'decrypt', succeeded: false });
          console.error('decrypt failed', e);
          return json({ error: 'Could not read this document number.' }, 500);
        }
      }

      default:
        return json({ error: 'Unknown action.' }, 400);
    }
  } catch (e) {
    if (e instanceof CryptoError) {
      console.error('crypto error', e.message);
      return json({ error: 'Could not process this document.' }, 400);
    }
    console.error('unhandled error', e);
    return json({ error: 'Something went wrong.' }, 500);
  }
});
