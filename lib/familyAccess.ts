/**
 * F9 mechanism 1 — the linked login, client side.
 *
 * A traveler profile the organizer already owns gains its own account, and from
 * then on every trip that profile attends simply appears for them. Two roles
 * use this module and they never overlap:
 *
 *   the ORGANIZER — invite, see status, revoke
 *   the LINKED MEMBER — accept once, then read their own trips
 *
 * The share-link mechanism is lib/tripSharing.ts. Separate module, separate
 * table, separate function, on purpose: the prompt asks for two mechanisms with
 * two security models rather than one path with a branch in it.
 */
import { supabase } from './supabase';
import type { Invite, TravelerForInvite } from './familyAccessFormat';

export {
  LINKED_ACCESS_DENIALS,
  LINKED_ACCESS_GRANTS,
  describeInvite,
  inviteBlockReason,
  inviteStatus,
} from './familyAccessFormat';
export type { Invite, InviteStatus, TravelerForInvite } from './familyAccessFormat';

async function callInviteFunction<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke('invite', { body });

  if (error) {
    // The function's own wording is the useful wording: it names the tier, the
    // child rule or the existing link specifically, and a generic "request
    // failed" would throw that away.
    const response = (error as { context?: Response }).context;
    if (response && typeof response.json === 'function') {
      const payload = await response.json().catch(() => null);
      if (payload?.error) throw new Error(payload.error);
    }
    throw new Error(error.message);
  }
  return data as T;
}

// ---------------------------------------------------------------------------
// The organizer's side
// ---------------------------------------------------------------------------

function toInvite(row: Record<string, unknown>): Invite {
  return {
    id: row.id as string,
    travelerId: row.traveler_id as string,
    createdAt: row.created_at as string,
    expiresAt: row.expires_at as string,
    acceptedAt: (row.accepted_at as string | null) ?? null,
  };
}

export async function listInvites(): Promise<Invite[]> {
  const { data, error } = await supabase
    .from('traveler_invites')
    .select('id, traveler_id, created_at, expires_at, accepted_at')
    .order('created_at', { ascending: false });

  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => toInvite(r as Record<string, unknown>));
}

export type NewInvite = { inviteId: string; code: string; expiresAt: string };

/**
 * Mint an invite code for one of your own traveler profiles.
 *
 * The code comes back exactly once and is never stored anywhere we can read it
 * again — only its hash reaches the database. Show it to the organizer, let
 * them send it however they like, and if they lose it, issue a new one.
 *
 * There is no "email it for them" step here: TripVault has no email provider
 * configured yet (see HISTORY.md), and a button that silently sends nothing
 * would be worse than one that does not exist.
 */
export async function createInvite(
  travelerId: string,
  expiresInDays?: number
): Promise<NewInvite> {
  return await callInviteFunction<NewInvite>({
    action: 'create',
    travelerId,
    ...(expiresInDays ? { expiresInDays } : {}),
  });
}

/** Withdraw an invite that has not been accepted. */
export async function cancelInvite(inviteId: string): Promise<void> {
  const { error } = await supabase.from('traveler_invites').delete().eq('id', inviteId);
  if (error) throw new Error(error.message);
}

/**
 * End a linked person's access.
 *
 * Deliberately a plain client write rather than a call to the Edge Function.
 * Revoking access must not be the operation that depends on a server being
 * reachable — the database permits clearing this column from the client
 * precisely so this always works, while GRANTING it stays server-only.
 *
 * Their own account is untouched: they are a genuine account holder in their
 * own right, and this removes what they can see, not who they are.
 */
export async function revokeLinkedAccess(travelerId: string): Promise<void> {
  const { error } = await supabase
    .from('travelers')
    .update({ linked_auth_user_id: null })
    .eq('id', travelerId);

  if (error) throw new Error(error.message);

  // Clear any invite too, so the profile can be re-invited later. Order
  // matters: access is cut first, tidying second.
  await supabase.from('traveler_invites').delete().eq('traveler_id', travelerId);
}

export type InvitableTraveler = TravelerForInvite & { id: string };

/** Traveler profiles with the fields the invite rules are decided on. */
export async function listTravelersForInvites(): Promise<InvitableTraveler[]> {
  const { data, error } = await supabase
    .from('travelers')
    .select('id, name, relationship, is_minor, linked_auth_user_id')
    .order('name', { ascending: true });

  if (error) throw new Error(error.message);
  return (data ?? []).map((r: Record<string, unknown>) => ({
    id: r.id as string,
    name: r.name as string,
    relationship: r.relationship as string,
    isMinor: Boolean(r.is_minor),
    linkedAuthUserId: (r.linked_auth_user_id as string | null) ?? null,
  }));
}

// ---------------------------------------------------------------------------
// The linked member's side
// ---------------------------------------------------------------------------

/** Redeem an invite code. The caller must already be signed in as themselves. */
export async function acceptInvite(
  code: string
): Promise<{ travelerId: string; travelerName: string }> {
  return await callInviteFunction({ action: 'accept', code: code.trim() });
}

export type LinkedIdentity = { travelerId: string; travelerName: string };

/**
 * The profile this login is linked to, or null for an ordinary organizer.
 *
 * This is what the app branches on to decide which experience to show. It reads
 * `travelers` under RLS: an organizer's own rows never match, because a profile
 * cannot be linked to the account that owns it — the database refuses that,
 * which is what keeps this test unambiguous.
 */
export async function getLinkedIdentity(): Promise<LinkedIdentity | null> {
  const { data: session } = await supabase.auth.getUser();
  const uid = session.user?.id;
  if (!uid) return null;

  const { data, error } = await supabase
    .from('travelers')
    .select('id, name')
    .eq('linked_auth_user_id', uid)
    .maybeSingle();

  if (error) return null;
  return data ? { travelerId: data.id as string, travelerName: data.name as string } : null;
}

export type LinkedTrip = {
  id: string;
  name: string;
  destination: string | null;
  startDate: string | null;
  endDate: string | null;
};

/**
 * The trips a linked member is on.
 *
 * No filter is applied here, and none is needed: RLS returns only trips where
 * their traveler_id appears in trip_travelers. Adding a client-side filter as
 * well would suggest the scoping lives here, which is exactly the wrong idea to
 * leave in the code — if this query ever returns something unexpected, the bug
 * is in the policy, and it should be visible as such.
 */
export async function listLinkedTrips(): Promise<LinkedTrip[]> {
  const { data, error } = await supabase
    .from('trips')
    .select('id, name, destination, start_date, end_date')
    .order('start_date', { ascending: true, nullsFirst: false });

  if (error) throw new Error(error.message);
  return (data ?? []).map((r: Record<string, unknown>) => ({
    id: r.id as string,
    name: r.name as string,
    destination: (r.destination as string | null) ?? null,
    startDate: (r.start_date as string | null) ?? null,
    endDate: (r.end_date as string | null) ?? null,
  }));
}

export type LinkedTripDetail = {
  trip: LinkedTrip;
  items: Record<string, unknown>[];
  checklist: Record<string, unknown>[];
};

export async function getLinkedTrip(tripId: string): Promise<LinkedTripDetail | null> {
  const [{ data: trip }, { data: items }, { data: checklist }] = await Promise.all([
    supabase
      .from('trips')
      .select('id, name, destination, start_date, end_date')
      .eq('id', tripId)
      .maybeSingle(),
    supabase
      .from('trip_items')
      .select('id, type, provider, confirmation_number, external_link, item_date, notes')
      .eq('trip_id', tripId)
      .order('item_date', { ascending: true, nullsFirst: false }),
    supabase
      .from('trip_checklist_items')
      .select('id, label, category, status')
      .eq('trip_id', tripId),
  ]);

  if (!trip) return null;

  return {
    trip: {
      id: trip.id as string,
      name: trip.name as string,
      destination: (trip.destination as string | null) ?? null,
      startDate: (trip.start_date as string | null) ?? null,
      endDate: (trip.end_date as string | null) ?? null,
    },
    items: (items ?? []) as Record<string, unknown>[],
    checklist: (checklist ?? []) as Record<string, unknown>[],
  };
}

export type LinkedDocument = {
  id: string;
  type: string;
  country: string | null;
  expiryDate: string | null;
  filePath: string | null;
};

/**
 * The linked member's own documents.
 *
 * Their own, and nobody else's — RLS scopes this to travelers linked to them.
 * Document NUMBERS are not fetched: decrypting one is an Edge Function call
 * written to the audit log, and F9's payoff is having the scan on your phone at
 * an airport, not reading the number off a screen.
 */
export async function listOwnDocuments(): Promise<LinkedDocument[]> {
  const { data, error } = await supabase
    .from('documents')
    .select('id, type, country, expiry_date, file_path')
    .order('expiry_date', { ascending: true, nullsFirst: false });

  if (error) throw new Error(error.message);
  return (data ?? []).map((r: Record<string, unknown>) => ({
    id: r.id as string,
    type: r.type as string,
    country: (r.country as string | null) ?? null,
    expiryDate: (r.expiry_date as string | null) ?? null,
    filePath: (r.file_path as string | null) ?? null,
  }));
}

/**
 * A short-lived URL for a document scan, so it can be saved for offline use.
 *
 * The signed URL is the download; keeping the file afterwards is the device's
 * business. That is worth naming as a real gap rather than a feature: once
 * saved, the file is outside the app's control entirely, which the feature
 * plan's security review already flags as an open question.
 */
export async function signedUrlForOwnDocument(filePath: string): Promise<string> {
  const { data, error } = await supabase.storage.from('documents').createSignedUrl(filePath, 60);
  if (error || !data) throw new Error(error?.message ?? 'Could not open that document.');
  return data.signedUrl;
}
