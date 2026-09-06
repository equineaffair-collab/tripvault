/**
 * F5 — the pure half of smart import.
 *
 * Validating what came back from an extraction, suggesting which trip a
 * forwarded booking belongs to, and the wording for both. No Supabase import,
 * so `node --test` can hold all of it to the rules — which matters more here
 * than usual, because everything in this file exists to stop a wrong booking
 * from looking like a right one.
 */

export const TRIP_ITEM_TYPES = [
  'flight',
  'accommodation',
  'car_hire',
  'transfer',
  'activity',
  'other',
] as const;
export type TripItemType = (typeof TRIP_ITEM_TYPES)[number];

export const TRIP_ITEM_LABELS: Record<TripItemType, string> = {
  flight: 'Flight',
  accommodation: 'Stay',
  car_hire: 'Car hire',
  transfer: 'Transfer',
  activity: 'Activity',
  other: 'Booking',
};

export type ExtractedBooking = {
  type: TripItemType;
  provider: string | null;
  confirmationNumber: string | null;
  itemDate: string | null;
  amountDue: number | null;
  dueDate: string | null;
  notes: string | null;
  confidence: 'high' | 'low';
};

/**
 * Turn whatever the model returned into something that can be written, or
 * refuse it.
 *
 * Deliberately strict, and deliberately does not repair. A field that arrives
 * in the wrong shape becomes null rather than a best guess: the user sees an
 * empty field and fills it in, which is a visible gap. A repaired value is an
 * invisible one, and this data ends up in a form somebody confirms at a glance.
 */
export function parseExtractedBooking(raw: unknown): ExtractedBooking | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  const type = TRIP_ITEM_TYPES.includes(r.type as TripItemType)
    ? (r.type as TripItemType)
    : 'other';

  const text = (value: unknown, max: number): string | null => {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed && trimmed.length <= max ? trimmed : trimmed ? trimmed.slice(0, max) : null;
  };

  const amount = typeof r.amountDue === 'number' && Number.isFinite(r.amountDue) && r.amountDue >= 0
    ? Math.round(r.amountDue * 100) / 100
    : null;

  return {
    type,
    provider: text(r.provider, 120),
    confirmationNumber: text(r.confirmationNumber, 120),
    itemDate: isoDateTimeOrNull(r.itemDate),
    amountDue: amount,
    dueDate: isoDateOrNull(r.dueDate),
    notes: text(r.notes, 2000),
    // Anything that did not explicitly claim high confidence is treated as low.
    // The default has to fall on the side of "check this".
    confidence: r.confidence === 'high' ? 'high' : 'low',
  };
}

/**
 * A date must be a real date the database will accept, or nothing.
 *
 * Handing Postgres "next Tuesday" or "2026-13-45" fails the whole insert, which
 * would turn one unreadable field into a lost booking.
 */
export function isoDateOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const m = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const [, y, mo, d] = m;
  const date = new Date(`${y}-${mo}-${d}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  // Round-tripping catches 2026-02-31, which Date rolls forward rather than
  // rejecting.
  return date.toISOString().slice(0, 10) === `${y}-${mo}-${d}` ? `${y}-${mo}-${d}` : null;
}

export function isoDateTimeOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const day = isoDateOrNull(trimmed);
  if (!day) return null;
  // Every return goes through toISOString, so a caller never has to handle two
  // shapes of the same value depending on whether a time was stated.
  const midnight = new Date(`${day}T00:00:00Z`).toISOString();
  if (!/\d{2}:\d{2}/.test(trimmed)) return midnight;

  const parsed = new Date(
    trimmed.endsWith('Z') || /[+-]\d{2}:?\d{2}$/.test(trimmed) ? trimmed : `${trimmed}Z`
  );
  return Number.isNaN(parsed.getTime()) ? midnight : parsed.toISOString();
}

/** Whether an extraction is worth pre-filling a form with at all. */
export function isUsableExtraction(booking: ExtractedBooking | null): boolean {
  if (!booking) return false;
  // A result with no provider, no reference and no date is not a booking; it is
  // the model being polite about a marketing email.
  return Boolean(booking.provider || booking.confirmationNumber || booking.itemDate);
}

// ---------------------------------------------------------------------------
// Which trip does this belong to?
// ---------------------------------------------------------------------------

export type TripWindow = {
  id: string;
  name: string;
  startDate: string | null;
  endDate: string | null;
};

export type TripSuggestion = {
  tripId: string;
  tripName: string;
  reason: string;
};

/**
 * Suggest a trip for a forwarded booking, or don't.
 *
 * The feature plan raises auto-assignment as an open question and calls it
 * nice-to-have. This suggests and never assigns, for a reason worth stating: a
 * booking silently filed under the wrong trip is worse than one sitting in a
 * holding area, because nobody goes looking for it. The user taps once either
 * way; only the failure modes differ.
 *
 * Ambiguity is reported as no suggestion rather than a first-past-the-post
 * winner. Two overlapping trips is exactly when a confident guess is most
 * likely to be wrong and least likely to be checked.
 */
export function suggestTrip(
  itemDate: string | null,
  trips: readonly TripWindow[]
): TripSuggestion | null {
  if (!itemDate) return null;
  const when = Date.parse(itemDate);
  if (Number.isNaN(when)) return null;

  const matches = trips.filter((trip) => {
    const start = trip.startDate ? Date.parse(`${trip.startDate}T00:00:00Z`) : null;
    const end = trip.endDate ? Date.parse(`${trip.endDate}T23:59:59Z`) : null;
    if (start === null && end === null) return false;
    if (start !== null && when < start) return false;
    if (end !== null && when > end) return false;
    return true;
  });

  if (matches.length !== 1) return null;

  return {
    tripId: matches[0].id,
    tripName: matches[0].name,
    reason: `${itemDate.slice(0, 10)} falls inside this trip’s dates.`,
  };
}

// ---------------------------------------------------------------------------
// Wording
// ---------------------------------------------------------------------------

export type InboundStatus = 'pending' | 'extracted' | 'unreadable' | 'rejected_tier' | 'failed';

export function describeInbound(status: InboundStatus, detail?: string | null): string {
  switch (status) {
    case 'extracted':
      return 'Read and added to your bookings.';
    case 'unreadable':
      return detail || "This didn't look like a booking confirmation, so nothing was added.";
    case 'rejected_tier':
      return 'Smart import is part of Pro. This email was kept, and will be read if you upgrade.';
    case 'failed':
      return detail || 'Something went wrong reading this one. It has been kept, so it can be retried.';
    default:
      // The state this project is actually in: mail arrives, is stored, and
      // waits for an extraction provider to be configured.
      return 'Received. Waiting to be read — booking extraction is not switched on yet.';
  }
}

export function holdingAreaSummary(count: number): string {
  if (count === 0) return 'Nothing waiting to be filed.';
  return count === 1
    ? '1 booking needs a trip.'
    : `${count} bookings need a trip.`;
}

export function forwardingAddress(localPart: string, domain: string): string {
  return `${localPart}@${domain.replace(/^@/, '')}`;
}

export const FORWARDING_ADDRESS_NOTE =
  'Forward a booking confirmation to this address from your normal email app and it will ' +
  'appear here, ready to be filed against a trip. Treat the address like a password: ' +
  'anything sent to it is trusted as yours. Replace it if it ever gets out.';

export const HOLDING_AREA_NOTE =
  'A forwarded email does not know which trip it belongs to — you were in your inbox, not in ' +
  'TripVault, when you sent it. Pick a trip and it moves across.';
