/**
 * F9 mechanism 2 — the one-off share link, client side.
 *
 * For a true outsider: someone who is not a traveler profile and has no account
 * at all. An unguessable token is the entire access control, so it is treated
 * like a credential — minted once, shown once, revocable, and never stored in a
 * form anyone can read back.
 *
 * Kept apart from lib/familyAccess.ts deliberately. The two mechanisms answer
 * different questions ("give my husband his own login" vs "let the neighbour
 * see where we are staying"), and merging them would mean one set of scoping
 * rules trying to serve both.
 */
import { supabase } from './supabase';
import type { ShareLink } from './familyAccessFormat';

export {
  SHARE_DOCUMENTS_WARNING,
  SHARE_LINK_NOTE,
  describeShareLink,
  shareBlockReason,
  shareLinkStatus,
  shareUrl,
} from './familyAccessFormat';
export type { ShareLink, ShareLinkStatus } from './familyAccessFormat';

function toShareLink(row: Record<string, unknown>): ShareLink {
  return {
    id: row.id as string,
    tripId: row.trip_id as string,
    label: (row.label as string | null) ?? null,
    includesDocuments: Boolean(row.includes_documents),
    revoked: Boolean(row.revoked),
    createdAt: row.created_at as string,
    expiresAt: (row.expires_at as string | null) ?? null,
  };
}

export async function listShareLinks(tripId?: string): Promise<ShareLink[]> {
  let query = supabase
    .from('share_links')
    .select('id, trip_id, label, includes_documents, revoked, created_at, expires_at')
    .order('created_at', { ascending: false });

  if (tripId) query = query.eq('trip_id', tripId);

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => toShareLink(r as Record<string, unknown>));
}

export type NewShareLink = {
  shareId: string;
  token: string;
  expiresAt: string | null;
  includesDocuments: boolean;
};

/**
 * Create a share link for one of your own trips.
 *
 * `includesDocuments` defaults to false and has to be passed explicitly as
 * true, here and again in the function, and again as a literal comparison in
 * the database write. Three places all defaulting to "no" is deliberate: this
 * is the one setting that turns a link about a holiday into a link to a
 * passport scan.
 *
 * The token comes back once. It is stored only as a hash, so a lost link cannot
 * be recovered — only replaced.
 */
export async function createShareLink(args: {
  tripId: string;
  label?: string | null;
  includesDocuments?: boolean;
  expiresInDays?: number | null;
}): Promise<NewShareLink> {
  const { data, error } = await supabase.functions.invoke('shared-trip', {
    body: {
      action: 'create',
      tripId: args.tripId,
      label: args.label ?? null,
      includesDocuments: args.includesDocuments === true,
      ...(args.expiresInDays ? { expiresInDays: args.expiresInDays } : {}),
    },
  });

  if (error) {
    const response = (error as { context?: Response }).context;
    if (response && typeof response.json === 'function') {
      const payload = await response.json().catch(() => null);
      if (payload?.error) throw new Error(payload.error);
    }
    throw new Error(error.message);
  }
  return data as NewShareLink;
}

/**
 * Stop a link working, permanently.
 *
 * A plain client write, like revoking a linked login and for the same reason:
 * the thing that takes access away must be the thing least likely to fail. The
 * database refuses to un-revoke, so this is one-way — which is the right shape
 * for an action taken because something went wrong.
 */
export async function revokeShareLink(id: string): Promise<void> {
  const { error } = await supabase.from('share_links').update({ revoked: true }).eq('id', id);
  if (error) throw new Error(error.message);
}

/** Remove a revoked or expired link from the list entirely. */
export async function deleteShareLink(id: string): Promise<void> {
  const { error } = await supabase.from('share_links').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

/** The project URL, for building the link the recipient opens. */
export function supabaseProjectUrl(): string {
  return process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
}
