/**
 * Bearer tokens for F9's two access mechanisms.
 *
 * A primitive shared by both, deliberately NOT a shared code path: neither
 * function calls into the other, and nothing here knows which mechanism is
 * asking. Hashing is the same arithmetic either way; the security models that
 * sit on top are what must stay apart.
 *
 * Why tokens are minted here rather than on the device: generating one in the
 * app would need a CSPRNG and SHA-256 on React Native, which means new native
 * dependencies. Deno has both built in. The token is returned to the caller
 * once and never written down -- only its hash reaches Postgres -- so the
 * property that matters for a leaked backup still holds.
 */

const encoder = new TextEncoder();

/** URL-safe base64 with no padding, so a token survives being pasted anywhere. */
function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * 32 bytes of CSPRNG output. That is the same order of entropy as a session
 * token, which is the right comparison: whoever holds this reads a passport.
 */
export function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

/** Lowercase hex SHA-256, matching the CHECK constraint on both token columns. */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(token));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * A token arriving from a request, normalised and sanity-checked before it is
 * hashed and looked up.
 *
 * Rejecting the wrong shape early means an obviously bogus request never
 * reaches the database, and -- more usefully -- it cannot be used to probe how
 * long a lookup takes for different inputs.
 */
export function normaliseToken(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const token = raw.trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  return token;
}

/**
 * A stable, non-reversible handle for the caller, for rate limiting.
 *
 * Rate limiting needs equality and nothing else, so the address itself is never
 * stored -- keeping it would collect personal data this feature has no use for.
 */
export async function clientHash(req: Request): Promise<string> {
  const forwarded = req.headers.get('x-forwarded-for') ?? '';
  const ip = forwarded.split(',')[0].trim() || 'unknown';
  return await hashToken(`share-link:${ip}`);
}
