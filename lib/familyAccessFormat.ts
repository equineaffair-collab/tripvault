/**
 * F9 — the pure half of family member access.
 *
 * Status arithmetic and wording for both mechanisms, with no Supabase import,
 * so `node --test` can hold it to the rules. Anything that talks to the network
 * lives in lib/familyAccess.ts (mechanism 1) or lib/tripSharing.ts (mechanism
 * 2), which are separate modules for the same reason the tables are separate.
 *
 * The refusal reasons below deliberately mirror the guards in migration 0010.
 * The database is what enforces them; this is what lets the interface say why
 * BEFORE someone taps a button and collects an error. When one changes, the
 * other has to — familyAccessFormat.test.ts asserts the pairs still line up.
 */
import type { Tier } from './tiers.ts';
import { hasFeature, smallestTierWith, TIER_LABELS } from './tiers.ts';

// ---------------------------------------------------------------------------
// Mechanism 1 — linked login
// ---------------------------------------------------------------------------

export type InviteStatus = 'pending' | 'expired' | 'accepted';

export type Invite = {
  id: string;
  travelerId: string;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
};

export function inviteStatus(invite: Invite, now: Date = new Date()): InviteStatus {
  if (invite.acceptedAt) return 'accepted';
  return Date.parse(invite.expiresAt) > now.getTime() ? 'pending' : 'expired';
}

export function describeInvite(invite: Invite, now: Date = new Date()): string {
  switch (inviteStatus(invite, now)) {
    case 'accepted':
      return 'Accepted — they have their own login.';
    case 'expired':
      return 'This invite has expired. Create a new one.';
    default: {
      const days = Math.ceil((Date.parse(invite.expiresAt) - now.getTime()) / 86_400_000);
      return days <= 1
        ? 'Waiting to be accepted — expires today.'
        : `Waiting to be accepted — expires in ${days} days.`;
    }
  }
}

export type TravelerForInvite = {
  name: string;
  isMinor: boolean;
  linkedAuthUserId: string | null;
  /** F11's relationship. Only 'self' changes the answer below. */
  relationship?: string;
};

/**
 * Why this profile cannot be invited, or null if it can.
 *
 * One reason per guard in 0010's check_traveler_invite, in the same order, so
 * the interface never offers an action the database is going to refuse.
 */
export function inviteBlockReason(args: {
  tier: Tier;
  traveler: TravelerForInvite;
}): string | null {
  if (!hasFeature(args.tier, 'trip_sharing')) {
    return `Family member access is part of ${TIER_LABELS[smallestTierWith('trip_sharing')]}.`;
  }
  if (args.traveler.isMinor) {
    return (
      `${args.traveler.name} is saved as a child, and a child's profile is not given its own ` +
      `login. You keep managing their documents from your own account.`
    );
  }
  if (args.traveler.linkedAuthUserId) {
    return `${args.traveler.name} already has their own login.`;
  }
  if (args.traveler.relationship === 'self') {
    // Not a database rule: 'self' is a label the account holder chose and can
    // change, so enforcing it in Postgres would be enforcing a preference. But
    // offering it is nonsense — you cannot invite yourself to your own account,
    // and the invite would only be redeemable by somebody else.
    return `This is your own profile. You already see everything in this account.`;
  }
  return null;
}

/**
 * What a linked person can and cannot see, in the words the organizer needs
 * before they invite someone.
 *
 * Stated plainly and kept next to the code that enforces it, because "what did
 * I just give them access to" is the question this feature has to answer well.
 */
export const LINKED_ACCESS_GRANTS = [
  'The trips you add them to — dates, destination and bookings',
  'That trip’s checklist',
  'Their own documents, including the scan, saved to their phone for offline use',
] as const;

export const LINKED_ACCESS_DENIALS = [
  'Your other trips, including ones they are not on',
  'Anyone else’s documents',
  'Anything they can change — their access is read-only',
] as const;

// ---------------------------------------------------------------------------
// Mechanism 2 — one-off share link
// ---------------------------------------------------------------------------

export type ShareLinkStatus = 'active' | 'revoked' | 'expired';

export type ShareLink = {
  id: string;
  tripId: string;
  label: string | null;
  includesDocuments: boolean;
  revoked: boolean;
  createdAt: string;
  expiresAt: string | null;
};

export function shareLinkStatus(link: ShareLink, now: Date = new Date()): ShareLinkStatus {
  if (link.revoked) return 'revoked';
  if (link.expiresAt && Date.parse(link.expiresAt) <= now.getTime()) return 'expired';
  return 'active';
}

export function describeShareLink(link: ShareLink, now: Date = new Date()): string {
  const who = link.label ? `Shared with ${link.label}` : 'Share link';

  switch (shareLinkStatus(link, now)) {
    case 'revoked':
      return `${who} — revoked, no longer opens.`;
    case 'expired':
      return `${who} — expired, no longer opens.`;
    default: {
      const scope = link.includesDocuments
        ? 'itinerary, checklist and documents'
        : 'itinerary and checklist only';
      const until = link.expiresAt
        ? `, until ${link.expiresAt.slice(0, 10)}`
        : ', with no expiry date';
      return `${who} — ${scope}${until}.`;
    }
  }
}

/**
 * The URL a recipient opens.
 *
 * It points at the `shared-trip` Edge Function, which renders the trip itself.
 * There is no web front end, and pointing a link at one that does not exist
 * would be a link nobody can open.
 */
export function shareUrl(supabaseUrl: string, token: string): string {
  return `${supabaseUrl.replace(/\/+$/, '')}/functions/v1/shared-trip?t=${encodeURIComponent(token)}`;
}

export function shareBlockReason(tier: Tier): string | null {
  return hasFeature(tier, 'trip_sharing')
    ? null
    : `Trip sharing is part of ${TIER_LABELS[smallestTierWith('trip_sharing')]}.`;
}

/**
 * The warning shown when documents are toggled on for a share.
 *
 * The feature plan is direct that the app can scope access technically but
 * cannot control what a recipient does with what they can see, and that the
 * account holder is responsible for who they share with. Saying so at the
 * moment of the decision is the only place that is useful.
 */
export const SHARE_DOCUMENTS_WARNING =
  'Anyone who opens this link will be able to view and save the passport scans for ' +
  'everyone on this trip. They do not need an account. Only turn this on if that is ' +
  'what you mean to do, and revoke the link when it is no longer needed.';

export const SHARE_LINK_NOTE =
  'Anyone with the link can open it — treat it like a key. It never shows document ' +
  'numbers, and it only ever shows this one trip.';
