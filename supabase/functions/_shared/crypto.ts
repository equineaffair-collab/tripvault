/**
 * F1 — envelope encryption for document numbers.
 *
 * The key lives in an Edge Function secret, never in the database and never in
 * the app bundle. A compromise of the Postgres database alone therefore yields
 * ciphertext without the means to read it, which is the property GDPR Art
 * 34(3)(a) and Australia's NDB scheme actually turn on: encryption only changes
 * your position in a breach if the keys were not taken with the data.
 *
 * AES-256-GCM, a fresh 96-bit IV per record, and the document's own id bound in
 * as additional authenticated data — so ciphertext copied from one row to
 * another fails to decrypt rather than silently returning another person's
 * document number.
 *
 * Written against Web Crypto only (no Deno or Node built-ins), so the same code
 * runs in the Edge Function and under `node --test`.
 */

/** Envelope version, so a future key rotation can be told apart on read. */
export const CURRENT_VERSION = 'v1';

const ALGORITHM = 'AES-GCM';
const IV_BYTES = 12; // 96 bits, the size AES-GCM is specified for
const KEY_BYTES = 32; // AES-256

export class CryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CryptoError';
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

// Backed by a concrete ArrayBuffer rather than the default ArrayBufferLike, so
// the result satisfies BufferSource for the Web Crypto calls below.
function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new CryptoError('Ciphertext is not valid base64.');
  }
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Import a base64 32-byte key. Generate one with:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 */
export async function importKey(base64Key: string): Promise<CryptoKey> {
  if (!base64Key) {
    throw new CryptoError('DOCUMENT_ENCRYPTION_KEY is not set.');
  }
  const raw = fromBase64(base64Key);
  if (raw.length !== KEY_BYTES) {
    throw new CryptoError(
      `DOCUMENT_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes, got ${raw.length}.`
    );
  }
  return crypto.subtle.importKey('raw', raw, ALGORITHM, false, ['encrypt', 'decrypt']);
}

/**
 * Returns "v1.<base64 iv>.<base64 ciphertext+tag>".
 *
 * `documentId` is bound in as additional authenticated data. It is not secret —
 * it just means the ciphertext is only valid in the row it was written for.
 */
export async function encryptDocumentNumber(
  plaintext: string,
  documentId: string,
  key: CryptoKey
): Promise<string> {
  const trimmed = plaintext.trim();
  if (!trimmed) throw new CryptoError('Document number is empty.');
  if (!documentId) throw new CryptoError('A document id is required to encrypt.');

  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const encoder = new TextEncoder();

  const ciphertext = await crypto.subtle.encrypt(
    { name: ALGORITHM, iv, additionalData: encoder.encode(documentId) },
    key,
    encoder.encode(trimmed)
  );

  return `${CURRENT_VERSION}.${toBase64(iv)}.${toBase64(new Uint8Array(ciphertext))}`;
}

/**
 * Reverses encryptDocumentNumber. Throws on any tampering: GCM's tag covers
 * both the ciphertext and the bound document id, so a modified row or a
 * ciphertext lifted from another document fails rather than returning garbage.
 */
export async function decryptDocumentNumber(
  envelope: string,
  documentId: string,
  key: CryptoKey
): Promise<string> {
  const parts = envelope.split('.');
  if (parts.length !== 3) {
    throw new CryptoError('Stored value is not a recognised encryption envelope.');
  }

  const [version, ivB64, ciphertextB64] = parts;
  if (version !== CURRENT_VERSION) {
    throw new CryptoError(`Unsupported envelope version "${version}".`);
  }

  const iv = fromBase64(ivB64);
  if (iv.length !== IV_BYTES) throw new CryptoError('Malformed initialization vector.');

  const encoder = new TextEncoder();
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      { name: ALGORITHM, iv, additionalData: encoder.encode(documentId) },
      key,
      fromBase64(ciphertextB64)
    );
  } catch {
    // Deliberately vague: distinguishing "wrong key" from "tampered" from
    // "wrong document" would tell an attacker which of those they achieved.
    throw new CryptoError('Could not decrypt this document number.');
  }

  return new TextDecoder().decode(plaintext);
}

/** Cheap shape check for the database CHECK constraint and for tests. */
export function looksLikeEnvelope(value: string): boolean {
  return /^v\d+\.[A-Za-z0-9+/]+=*\.[A-Za-z0-9+/]+=*$/.test(value);
}
