/**
 * F5 — smart import, client side.
 *
 * Two paths that share nothing but a destination. Path A is synchronous and
 * happens inside a trip; Path B happens in the user's mail app and lands in the
 * holding area. The only thing this module does for both is assign an item to a
 * trip, which is where the two paths finally meet.
 */
import { supabase } from './supabase';
import type { ExtractedBooking, InboundStatus, TripWindow } from './smartImportFormat';

export {
  FORWARDING_ADDRESS_NOTE,
  HOLDING_AREA_NOTE,
  TRIP_ITEM_LABELS,
  describeInbound,
  forwardingAddress,
  holdingAreaSummary,
  isUsableExtraction,
  parseExtractedBooking,
  suggestTrip,
} from './smartImportFormat';
export type {
  ExtractedBooking,
  InboundStatus,
  TripItemType,
  TripSuggestion,
  TripWindow,
} from './smartImportFormat';

/** Raised when the account's plan does not include smart import. */
export class SmartImportNotIncluded extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SmartImportNotIncluded';
  }
}

/**
 * Raised when no extraction provider is configured on the project.
 *
 * A distinct type because the answer is completely different: the user has done
 * nothing wrong and cannot fix it, so the app falls back to the manual form
 * rather than asking them to try again.
 */
export class ExtractionUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExtractionUnavailable';
  }
}

async function call<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke('smart-import', { body });

  if (error) {
    const response = (error as { context?: Response }).context;
    if (response && typeof response.json === 'function') {
      const payload = await response.json().catch(() => null);
      if (payload?.code === 'TIER_REQUIRED') throw new SmartImportNotIncluded(payload.error);
      if (payload?.code === 'EXTRACTION_UNAVAILABLE') throw new ExtractionUnavailable(payload.error);
      if (payload?.error) throw new Error(payload.error);
    }
    throw new Error(error.message);
  }
  return data as T;
}

// ---------------------------------------------------------------------------
// Path B — the forwarding address
// ---------------------------------------------------------------------------

export type ForwardingAddress = {
  localPart: string;
  domain: string;
  /** False until an inbound domain exists. The address cannot receive mail yet. */
  configured: boolean;
  createdAt: string;
  rotatedAt: string | null;
};

export const getForwardingAddress = () => call<ForwardingAddress>({ action: 'address' });

/**
 * Replace the address. The old one stops working immediately.
 *
 * The feature plan asks for this specifically: the address is a credential, so
 * there has to be a way to replace one that has leaked.
 */
export const rotateForwardingAddress = () => call<ForwardingAddress>({ action: 'rotate' });

/** Destroy the address entirely, turning the feature off. */
export async function removeForwardingAddress(): Promise<void> {
  const { error } = await supabase.from('forwarding_addresses').delete().not('user_id', 'is', null);
  if (error) throw new Error(error.message);
}

export type InboundEmail = {
  id: string;
  fromAddress: string | null;
  subject: string | null;
  receivedAt: string;
  status: InboundStatus;
  detail: string | null;
  tripItemId: string | null;
};

/**
 * What has arrived, and what became of it.
 *
 * Without this the whole path is invisible: someone forwards a confirmation,
 * nothing appears, and there is no way to tell whether it was lost, ignored or
 * misread. Path B is asynchronous, so the receipt IS the feature.
 */
export async function listInboundEmails(limit = 25): Promise<InboundEmail[]> {
  const { data, error } = await supabase
    .from('inbound_emails')
    .select('id, from_address, subject, received_at, status, detail, trip_item_id')
    .order('received_at', { ascending: false })
    .limit(limit);

  if (error) throw new Error(error.message);
  return (data ?? []).map((r: Record<string, unknown>) => ({
    id: r.id as string,
    fromAddress: (r.from_address as string | null) ?? null,
    subject: (r.subject as string | null) ?? null,
    receivedAt: r.received_at as string,
    status: r.status as InboundStatus,
    detail: (r.detail as string | null) ?? null,
    tripItemId: (r.trip_item_id as string | null) ?? null,
  }));
}

/** Delete a received message, including the stored copy of its text. */
export async function deleteInboundEmail(id: string): Promise<void> {
  const { error } = await supabase.from('inbound_emails').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

// ---------------------------------------------------------------------------
// Path A — reading a booking inside the app
// ---------------------------------------------------------------------------

/**
 * Read booking text and return the fields, unsaved.
 *
 * Nothing is written here on purpose. F5 specifies that the form pre-fills and
 * the user confirms or corrects before saving, which is the same shape F1 uses
 * for a scanned passport: a model's reading of a document is a draft.
 */
export async function extractBookingText(text: string): Promise<ExtractedBooking> {
  const { booking } = await call<{ booking: ExtractedBooking }>({ action: 'extract', text });
  return booking;
}

// ---------------------------------------------------------------------------
// Where the two paths meet
// ---------------------------------------------------------------------------

export type HoldingItem = {
  id: string;
  type: string;
  provider: string | null;
  confirmationNumber: string | null;
  itemDate: string | null;
  source: string;
  notes: string | null;
};

/** Bookings with no trip yet. */
export async function listHoldingArea(): Promise<HoldingItem[]> {
  const { data, error } = await supabase
    .from('trip_items')
    .select('id, type, provider, confirmation_number, item_date, source, notes')
    .is('trip_id', null)
    .order('item_date', { ascending: true, nullsFirst: false });

  if (error) throw new Error(error.message);
  return (data ?? []).map((r: Record<string, unknown>) => ({
    id: r.id as string,
    type: r.type as string,
    provider: (r.provider as string | null) ?? null,
    confirmationNumber: (r.confirmation_number as string | null) ?? null,
    itemDate: (r.item_date as string | null) ?? null,
    source: r.source as string,
    notes: (r.notes as string | null) ?? null,
  }));
}

/** Move a holding-area booking into a trip. */
export async function assignToTrip(itemId: string, tripId: string): Promise<void> {
  const { error } = await supabase
    .from('trip_items')
    .update({ trip_id: tripId })
    .eq('id', itemId);
  if (error) throw new Error(error.message);
}

export async function discardHoldingItem(itemId: string): Promise<void> {
  const { error } = await supabase.from('trip_items').delete().eq('id', itemId);
  if (error) throw new Error(error.message);
}

/** Trips with their date windows, for suggesting where a booking belongs. */
export async function listTripWindows(): Promise<TripWindow[]> {
  const { data, error } = await supabase
    .from('trips')
    .select('id, name, start_date, end_date')
    .order('start_date', { ascending: false, nullsFirst: false });

  if (error) throw new Error(error.message);
  return (data ?? []).map((r: Record<string, unknown>) => ({
    id: r.id as string,
    name: r.name as string,
    startDate: (r.start_date as string | null) ?? null,
    endDate: (r.end_date as string | null) ?? null,
  }));
}
