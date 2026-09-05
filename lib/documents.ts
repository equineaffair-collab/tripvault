/**
 * F1 — client access to the document vault.
 *
 * Two different paths on purpose:
 *
 * - Metadata (type, country, expiry, primary flag) is read straight from
 *   Postgres under RLS. The encrypted number is never selected here; it would
 *   be useless ciphertext anyway, and not fetching it keeps it out of app
 *   memory and any debug logging.
 *
 * - The number in the clear, and every write, go through the `documents` Edge
 *   Function, which is the only place the encryption key exists. Each of those
 *   calls is recorded in document_access_log.
 */
import { supabase } from './supabase';

export const DOCUMENT_TYPES = ['passport', 'visa', 'id_card', 'other'] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export const DOCUMENT_TYPE_LABELS: Record<DocumentType, string> = {
  passport: 'Passport',
  visa: 'Visa',
  id_card: 'ID card',
  other: 'Other document',
};

/** What the app holds in memory. Note the absence of the document number. */
export type DocumentSummary = {
  id: string;
  traveler_id: string;
  type: DocumentType;
  country: string | null;
  issue_date: string | null;
  expiry_date: string | null;
  is_primary: boolean;
  file_path: string | null;
  created_at: string;
};

export type DocumentInput = {
  travelerId: string;
  type: DocumentType;
  country?: string | null;
  documentNumber: string;
  issueDate?: string | null;
  expiryDate?: string | null;
  isPrimary?: boolean;
  filePath?: string | null;
  /** Set only when confirming the parent/guardian gate for a minor profile. */
  guardianAcknowledged?: boolean;
};

/** Thrown when a minor's profile has not had its guardian gate confirmed yet. */
export class GuardianAcknowledgementRequired extends Error {
  constructor() {
    super('A parent or guardian must confirm before adding this document.');
    this.name = 'GuardianAcknowledgementRequired';
  }
}

const SUMMARY_COLUMNS =
  'id, traveler_id, type, country, issue_date, expiry_date, is_primary, file_path, created_at';

async function callFunction<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke('documents', { body });

  if (error) {
    // supabase-js surfaces a non-2xx as a FunctionsHttpError whose body carries
    // our own error payload; read it so the guardian gate can be distinguished
    // from a generic failure.
    const response = (error as { context?: Response }).context;
    if (response && typeof response.json === 'function') {
      const payload = await response.json().catch(() => null);
      if (payload?.code === 'GUARDIAN_ACKNOWLEDGEMENT_REQUIRED') {
        throw new GuardianAcknowledgementRequired();
      }
      if (payload?.error) throw new Error(payload.error);
    }
    throw new Error(error.message);
  }

  if (data && typeof data === 'object' && 'error' in data) {
    throw new Error(String((data as { error: unknown }).error));
  }
  return data as T;
}

/** Metadata for one traveler's documents. Does not include the number. */
export async function listDocuments(travelerId: string): Promise<DocumentSummary[]> {
  const { data, error } = await supabase
    .from('documents')
    .select(SUMMARY_COLUMNS)
    .eq('traveler_id', travelerId)
    .order('is_primary', { ascending: false })
    .order('created_at', { ascending: true });

  if (error) throw new Error(error.message);
  return (data ?? []) as DocumentSummary[];
}

/** Every document across the account, for the Documents tab and F2's reminders. */
export async function listAllDocuments(): Promise<DocumentSummary[]> {
  const { data, error } = await supabase
    .from('documents')
    .select(SUMMARY_COLUMNS)
    .order('expiry_date', { ascending: true, nullsFirst: false });

  if (error) throw new Error(error.message);
  return (data ?? []) as DocumentSummary[];
}

export async function createDocument(input: DocumentInput): Promise<DocumentSummary> {
  const { document } = await callFunction<{ document: DocumentSummary }>({
    action: 'create',
    ...input,
  });
  return document;
}

export async function updateDocument(
  documentId: string,
  changes: Partial<Omit<DocumentInput, 'travelerId'>>
): Promise<DocumentSummary> {
  const { document } = await callFunction<{ document: DocumentSummary }>({
    action: 'update',
    documentId,
    ...changes,
  });
  return document;
}

/**
 * Reveal the number in the clear. Deliberately a separate, explicit call rather
 * than something the list screen fetches: every invocation is logged, so it
 * should happen when the user actually asks to see it, not on every render.
 */
export async function revealDocumentNumber(documentId: string): Promise<string> {
  const { documentNumber } = await callFunction<{ documentNumber: string }>({
    action: 'decrypt',
    documentId,
  });
  return documentNumber;
}

/** Deleting needs no key, so it goes straight to Postgres under RLS. */
export async function deleteDocument(documentId: string): Promise<void> {
  const { error } = await supabase.from('documents').delete().eq('id', documentId);
  if (error) throw new Error(error.message);
}

/**
 * A short-lived URL for the stored scan. The bucket is private, so this is the
 * only way to view one; the link is deliberately not persisted anywhere.
 */
export async function getScanUrl(filePath: string, expiresInSeconds = 60): Promise<string> {
  const { data, error } = await supabase.storage
    .from('documents')
    .createSignedUrl(filePath, expiresInSeconds);

  if (error) throw new Error(error.message);
  return data.signedUrl;
}

/**
 * Object path convention the storage policies enforce:
 *   <auth user id>/<traveler id>/<document id>.<ext>
 * The first segment must be the caller's own user id or the policy rejects it.
 */
export function scanObjectPath(
  userId: string,
  travelerId: string,
  documentId: string,
  extension = 'jpg'
): string {
  return `${userId}/${travelerId}/${documentId}.${extension}`;
}
