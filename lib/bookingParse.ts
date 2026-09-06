/**
 * F5 — reading a booking confirmation without a language model.
 *
 * The same argument that moved F1's passport extraction on-device applies here
 * more than it first appears. F1's case was that an MRZ is a fixed-width string
 * with check digits, so once the characters are read the parse is arithmetic
 * rather than interpretation. A booking confirmation looks like the opposite --
 * arbitrary prose, hundreds of vendors, no two alike -- and that is why the
 * feature plan kept the Claude API for it.
 *
 * But most real confirmations are not prose to a machine. They carry structured
 * data deliberately, because the airlines and hotels want software to read them:
 *
 *   1. schema.org JSON-LD in the HTML body. Google's email markup spec exists
 *      precisely so a booking can be read without guessing, and FlightReservation
 *      / LodgingReservation / RentalCarReservation are widely emitted by
 *      airlines, hotel chains and the big OTAs. This is the MRZ of email: an
 *      exact, machine-readable payload sitting inside a human-readable message.
 *   2. An .ics attachment, which most flight and hotel confirmations include.
 *   3. Failing both, patterns that are genuinely regular: flight numbers, record
 *      locators, currency amounts, ISO and long-form dates.
 *
 * So extraction is tiered, and the tier is reported. The first two are exact and
 * come back as high confidence. The third is pattern matching and always comes
 * back LOW, which the interface shows as "worth checking" -- because a guess
 * that is presented as a fact is the failure mode that matters here.
 *
 * What this does not do is read a badly-worded confirmation from a small vendor
 * that ships neither markup nor a calendar file. Those fall through to the form
 * with whatever could be found filled in, which is the same place a failed model
 * call would leave them. See extraction.ts for how a model, if one is ever
 * configured, slots in behind this rather than in front of it.
 */
import {
  TRIP_ITEM_TYPES,
  isoDateOrNull,
  isoDateTimeOrNull,
  parseExtractedBooking,
  type ExtractedBooking,
  type TripItemType,
} from './smartImportFormat.ts';

export type ParseInput = {
  /** The plain-text body, or OCR output from a photo. */
  text?: string | null;
  /** The HTML body, where schema.org markup lives. */
  html?: string | null;
  subject?: string | null;
  fromAddress?: string | null;
  /** The contents of an .ics attachment, if one came with the message. */
  ics?: string | null;
};

/** Which tier answered. Recorded so a bad result can be traced to its method. */
export type ParseMethod = 'json-ld' | 'ics' | 'patterns';

export type ParseResult = { booking: ExtractedBooking; method: ParseMethod } | null;

/**
 * Read a booking, best method first.
 *
 * Tiers are tried in order of exactness and the first usable answer wins. A
 * later tier is never used to "fill in" fields the earlier one left null:
 * mixing an exact source with a guessed one produces a record that is partly
 * trustworthy, and nothing downstream could tell which half was which.
 */
export function parseBooking(input: ParseInput): ParseResult {
  const fromJsonLd = input.html ? fromSchemaOrg(input.html) : null;
  if (fromJsonLd) return { booking: fromJsonLd, method: 'json-ld' };

  const fromIcs = input.ics ? fromCalendar(input.ics) : null;
  if (fromIcs) return { booking: fromIcs, method: 'ics' };

  const body = [input.text, input.html ? stripTags(input.html) : null]
    .filter(Boolean)
    .join('\n');

  const guessed = fromPatterns({
    body,
    subject: input.subject ?? null,
    fromAddress: input.fromAddress ?? null,
  });

  return guessed ? { booking: guessed, method: 'patterns' } : null;
}

// ---------------------------------------------------------------------------
// Tier 1 — schema.org JSON-LD
// ---------------------------------------------------------------------------

/**
 * schema.org reservation types, mapped to ours.
 *
 * Anything not listed is not silently treated as 'other': an unknown @type is
 * more likely to be a newsletter's Article markup than a booking, and treating
 * it as a booking would manufacture an item out of a marketing email.
 */
const SCHEMA_TYPES: Record<string, TripItemType> = {
  FlightReservation: 'flight',
  LodgingReservation: 'accommodation',
  RentalCarReservation: 'car_hire',
  BusReservation: 'transfer',
  TrainReservation: 'transfer',
  TaxiReservation: 'transfer',
  EventReservation: 'activity',
  FoodEstablishmentReservation: 'activity',
};

function fromSchemaOrg(html: string): ExtractedBooking | null {
  for (const block of jsonLdBlocks(html)) {
    for (const node of flattenGraph(block)) {
      const booking = reservationToBooking(node);
      if (booking) return booking;
    }
  }
  return null;
}

/** Every <script type="application/ld+json"> payload, parsed and skipped if invalid. */
function jsonLdBlocks(html: string): unknown[] {
  const out: unknown[] = [];
  const pattern =
    /<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

  for (const match of html.matchAll(pattern)) {
    try {
      out.push(JSON.parse(match[1].trim()));
    } catch {
      // A single malformed block must not lose the well-formed one beside it.
    }
  }
  return out;
}

/** JSON-LD arrives as an object, an array, or an @graph. Flatten all three. */
function flattenGraph(node: unknown, depth = 0): Record<string, unknown>[] {
  if (depth > 4 || !node) return [];
  if (Array.isArray(node)) return node.flatMap((n) => flattenGraph(n, depth + 1));
  if (typeof node !== 'object') return [];

  const obj = node as Record<string, unknown>;
  const nested = obj['@graph'] ? flattenGraph(obj['@graph'], depth + 1) : [];
  return [obj, ...nested];
}

function reservationToBooking(node: Record<string, unknown>): ExtractedBooking | null {
  const rawType = node['@type'];
  const typeName = Array.isArray(rawType) ? String(rawType[0]) : String(rawType ?? '');
  const type = SCHEMA_TYPES[typeName];
  if (!type) return null;

  const target = asObject(node.reservationFor);

  return parseExtractedBooking({
    type,
    provider: providerFromReservation(type, node, target),
    confirmationNumber: str(node.reservationNumber) ?? str(node.reservationId),
    itemDate: isoDateTimeOrNull(startTimeFor(type, node, target)),
    // `totalPrice` is what the booking COST, not what is still owed, and
    // amountDue means money outstanding. Conflating them would show a paid
    // holiday as a bill. There is no schema.org field for a balance due, so
    // this stays null unless the pattern tier finds one.
    amountDue: null,
    dueDate: null,
    notes: notesFor(type, node, target),
    confidence: 'high',
  });
}

function startTimeFor(
  type: TripItemType,
  node: Record<string, unknown>,
  target: Record<string, unknown> | null
): string | null {
  if (type === 'accommodation') return str(node.checkinTime) ?? str(node.checkinDate);
  if (type === 'car_hire') return str(node.pickupTime) ?? str(node.dropoffTime);

  return (
    str(target?.departureTime) ??
    str(target?.startDate) ??
    str(node.startTime) ??
    str(node.startDate) ??
    null
  );
}

function providerFromReservation(
  type: TripItemType,
  node: Record<string, unknown>,
  target: Record<string, unknown> | null
): string | null {
  if (type === 'flight') {
    const airline = asObject(target?.airline);
    return str(airline?.name) ?? str(airline?.iataCode) ?? str(target?.name);
  }
  if (type === 'car_hire') {
    const company = asObject(target?.rentalCompany) ?? asObject(node.provider);
    return str(company?.name) ?? str(target?.name);
  }

  // For a stay or an activity, the thing reserved IS the provider: the hotel,
  // the restaurant, the venue.
  return str(target?.name) ?? str(asObject(node.provider)?.name) ?? null;
}

function notesFor(
  type: TripItemType,
  node: Record<string, unknown>,
  target: Record<string, unknown> | null
): string | null {
  const parts: string[] = [];

  if (type === 'flight') {
    const airline = asObject(target?.airline);
    const number = str(target?.flightNumber);
    const iata = str(airline?.iataCode);
    if (number) parts.push(iata && !number.startsWith(iata) ? `${iata}${number}` : number);

    const from = str(asObject(target?.departureAirport)?.iataCode);
    const to = str(asObject(target?.arrivalAirport)?.iataCode);
    if (from && to) parts.push(`${from} to ${to}`);
  }

  if (type === 'accommodation') {
    const nights = str(node.checkoutTime) ?? str(node.checkoutDate);
    if (nights) parts.push(`Checkout ${nights.slice(0, 10)}`);
  }

  const address = str(asObject(target?.address)?.addressLocality);
  if (address) parts.push(address);

  return parts.length > 0 ? parts.join(' · ') : null;
}

// ---------------------------------------------------------------------------
// Tier 2 — the .ics attachment
// ---------------------------------------------------------------------------

/**
 * Read the first VEVENT.
 *
 * iCalendar folds long lines by continuing them with a leading space, so lines
 * are unfolded before anything else -- a booking reference is exactly the kind
 * of value long enough to be split across two lines.
 */
function fromCalendar(ics: string): ExtractedBooking | null {
  const unfolded = ics.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '');
  const event = unfolded.split('BEGIN:VEVENT')[1];
  if (!event) return null;

  const field = (name: string): string | null => {
    // Properties may carry parameters: DTSTART;TZID=Australia/Sydney:2027...
    const m = event.match(new RegExp(`^${name}(?:;[^:\\n]*)?:(.*)$`, 'im'));
    return m ? unescapeIcs(m[1].trim()) : null;
  };

  const summary = field('SUMMARY');
  const start = icsDate(field('DTSTART'));
  if (!summary && !start) return null;

  const description = field('DESCRIPTION');
  const haystack = [summary, description, field('LOCATION')].filter(Boolean).join('\n');

  return parseExtractedBooking({
    type: guessType(haystack) ?? 'other',
    provider: providerFromSummary(summary),
    confirmationNumber: findReference(haystack),
    itemDate: start,
    amountDue: null,
    dueDate: null,
    notes: field('LOCATION'),
    // A calendar entry states the time exactly, which is the field most worth
    // being right about. The type and the provider are still read out of free
    // text, so this is not claimed as high.
    confidence: 'low',
  });
}

function icsDate(value: string | null): string | null {
  if (!value) return null;
  // 20270314T092000Z, 20270314T092000, or 20270314
  const m = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (!m) return isoDateTimeOrNull(value);

  const [, y, mo, d, hh, mm] = m;
  const day = isoDateOrNull(`${y}-${mo}-${d}`);
  if (!day) return null;
  return isoDateTimeOrNull(hh ? `${day}T${hh}:${mm ?? '00'}:00Z` : day);
}

function unescapeIcs(value: string): string {
  return value.replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1').trim();
}

/** "Flight QF1 to London" -> "QF1 to London" is not a provider; "Qantas" is. */
function providerFromSummary(summary: string | null): string | null {
  if (!summary) return null;
  const cleaned = summary
    .replace(/^\s*(booking|reservation|confirmation|itinerary)\s*[:\-–]\s*/i, '')
    .trim();
  const first = cleaned.split(/\s+[-–—:]\s+|,/)[0]?.trim();
  return first && first.length <= 60 ? first : null;
}

// ---------------------------------------------------------------------------
// Tier 3 — patterns, always low confidence
// ---------------------------------------------------------------------------

type PatternInput = { body: string; subject: string | null; fromAddress: string | null };

function fromPatterns(input: PatternInput): ExtractedBooking | null {
  const haystack = [input.subject, input.body].filter(Boolean).join('\n');
  if (!haystack.trim()) return null;

  const type = guessType(haystack);
  const reference = findReference(haystack);
  const when = findDate(haystack);
  const labelledProvider = findLabelledProvider(input.body);
  const due = findAmountDue(haystack);

  // What counts as evidence that this IS a booking: something stated in the
  // message. A reference, a date, or a provider the text actually names.
  //
  // The sender's domain is deliberately NOT evidence, and getting that wrong is
  // how a live run turned an airline's marketing email into a booking: the
  // domain qualified it, so "Summer sale! Save 30% on beach holidays" became a
  // trip item. Every promotional email an airline sends would have.
  if (!reference && !when && !labelledProvider) return null;

  // Only once the message has qualified does the sender fill in a provider the
  // text did not name. Enrichment, not evidence.
  const provider = labelledProvider ?? providerFromSender(input.fromAddress);

  return parseExtractedBooking({
    type: type ?? 'other',
    provider,
    confirmationNumber: reference,
    itemDate: when,
    amountDue: due?.amount ?? null,
    dueDate: due?.dueDate ?? null,
    notes: findFlightNumber(haystack),
    // Never anything else. Every value above was inferred from wording.
    confidence: 'low',
  });
}

const TYPE_HINTS: [TripItemType, RegExp][] = [
  ['flight', /\b(flight|boarding pass|departure gate|check[- ]?in opens|airline|e-?ticket)\b/i],
  ['accommodation', /\b(hotel|check[- ]?in|check[- ]?out|nights?\s+stay|room type|guesthouse|apartment)\b/i],
  ['car_hire', /\b(car hire|car rental|rental car|pick[- ]?up location|drop[- ]?off|hire car)\b/i],
  ['transfer', /\b(transfer|shuttle|train|rail|coach|bus|taxi|pick[- ]?up time)\b/i],
  ['activity', /\b(tour|ticket|admission|experience|excursion|table for|dining)\b/i],
];

function guessType(text: string): TripItemType | null {
  // First match in listed order wins, and the order runs most specific first:
  // a flight confirmation almost always says "check-in" too.
  for (const [type, pattern] of TYPE_HINTS) {
    if (pattern.test(text)) return type;
  }
  return null;
}

/**
 * A booking reference, found by its label rather than its shape.
 *
 * Searching for "six alphanumeric characters" anywhere in an email matches
 * dozens of things -- a tracking pixel id, a coupon code, half a postcode. The
 * label is what makes it a reference, so the label is what is required.
 */
function findReference(text: string): string | null {
  // Label, then up to a few words of filler, then a separator, then the value.
  // Every candidate is checked rather than only the first: the first thing
  // after a label word is often another label word.
  const pattern =
    /\b(?:booking|confirmation|reservation|record\s*locator|itinerary|pnr|reference|ref)\b[^\n:#]{0,20}?(?::|#|\bis\b)\s*([^\s,;]{4,15})/gi;

  for (const m of text.matchAll(pattern)) {
    const value = m[1].replace(/[.,;:]+$/, '');
    if (looksLikeReference(value)) return value.toUpperCase();
  }
  return null;
}

/**
 * Whether a captured token is plausibly a booking reference.
 *
 * The regex above cannot do this itself: it has to be case-insensitive to find
 * the label, which makes its character classes case-insensitive too — so
 * "Booking reference: ZZ9ABC" happily captured the word "reference". The value
 * is therefore judged separately, case intact.
 */
function looksLikeReference(value: string): boolean {
  if (!/^[A-Za-z0-9-]{4,15}$/.test(value)) return false;

  const hasDigit = /\d/.test(value);
  const hasLetter = /[A-Za-z]/.test(value);

  // All digits and long: an order total in cents, or a phone number.
  if (!hasLetter && value.length > 8) return false;
  // A plain lowercase word is a label the pattern failed to consume.
  if (hasLetter && !hasDigit && value === value.toLowerCase()) return false;

  return hasDigit || hasLetter;
}

const MONTHS =
  'january|february|march|april|may|june|july|august|september|october|november|december';

function findDate(text: string): string | null {
  const iso = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) {
    const withTime = text.match(
      new RegExp(`${iso[0]}[T ](\\d{2}):(\\d{2})`)
    );
    const day = isoDateOrNull(iso[0]);
    if (day) return isoDateTimeOrNull(withTime ? `${day}T${withTime[1]}:${withTime[2]}:00Z` : day);
  }

  // "14 March 2027" and "March 14, 2027"
  const dmy = text.match(new RegExp(`\\b(\\d{1,2})\\s+(${MONTHS})\\w*\\s+(\\d{4})`, 'i'));
  if (dmy) return fromParts(dmy[3], dmy[2], dmy[1], text);

  const mdy = text.match(new RegExp(`\\b(${MONTHS})\\w*\\s+(\\d{1,2}),?\\s+(\\d{4})`, 'i'));
  if (mdy) return fromParts(mdy[3], mdy[1], mdy[2], text);

  // Deliberately no support for 03/04/2027. That is 3 April to most of the
  // world and 4 March to the United States, and nothing in an email reliably
  // says which -- a booking silently moved by a month is worse than a blank
  // field the user fills in.
  return null;
}

function fromParts(year: string, monthName: string, day: string, text: string): string | null {
  const month = MONTHS.split('|').indexOf(monthName.toLowerCase()) + 1;
  if (month === 0) return null;

  const iso = isoDateOrNull(
    `${year}-${String(month).padStart(2, '0')}-${day.padStart(2, '0')}`
  );
  if (!iso) return null;

  const time = text.match(/\b(?:at\s+)?([01]?\d|2[0-3]):([0-5]\d)\b/);
  return isoDateTimeOrNull(time ? `${iso}T${time[1].padStart(2, '0')}:${time[2]}:00Z` : iso);
}

/** Money still owed, which is a different thing from what a booking cost. */
function findAmountDue(text: string): { amount: number; dueDate: string | null } | null {
  const m = text.match(
    /\b(?:balance|amount|payment)\s+(?:due|outstanding|remaining|to pay)\b[^\d]{0,20}([\d.,]+)/i
  );
  if (!m) return null;

  const amount = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const byDate = text.match(new RegExp(`due (?:by|on|before)\\s+([^\\n.]{4,30})`, 'i'));
  return { amount, dueDate: byDate ? isoDateOrNull(findDate(byDate[1]) ?? '') : null };
}

function findFlightNumber(text: string): string | null {
  const m = text.match(/\b([A-Z]{2}|[A-Z]\d|\d[A-Z])\s?(\d{1,4})\b(?=[^\n]{0,40}(flight|depart))/i);
  if (m) return `${m[1].toUpperCase()}${m[2]}`;

  const labelled = text.match(/\bflight\s*(?:number|no\.?|#)?\s*[:\-]?\s*([A-Z]{2}\s?\d{1,4})\b/i);
  return labelled ? labelled[1].toUpperCase().replace(/\s/g, '') : null;
}

/** A provider the message actually names. Counts as evidence of a booking. */
function findLabelledProvider(body: string): string | null {
  const labelled = body.match(
    /\b(?:operated by|provided by|your host|hotel|airline|supplier)\s*[:\-]\s*([^\n,.]{2,60})/i
  );
  return labelled ? labelled[1].trim() : null;
}

/**
 * Who probably supplied the service, from the sender's address.
 *
 * Used only to fill in a provider once the message has already qualified as a
 * booking on its own content. It is a weak signal even then: a confirmation
 * forwarded from an OTA names the OTA, not the airline.
 */
function providerFromSender(fromAddress: string | null): string | null {
  const domain = fromAddress?.match(/@([^>\s]+)/)?.[1];
  if (!domain) return null;

  const label = domain
    .replace(/^(mail|email|no-?reply|noreply|bookings?|reservations?|info|notifications?)\./i, '')
    .split('.')[0];

  if (!label || label.length < 2 || /^(gmail|outlook|hotmail|yahoo|icloud|proton)$/i.test(label)) {
    // A confirmation forwarded from a personal address says nothing about who
    // supplied anything.
    return null;
  }
  return label.charAt(0).toUpperCase() + label.slice(1);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function str(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Enough HTML stripping to run patterns over a message that has no text part. */
export function stripTags(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/[ \t]{2,}/g, ' ')
    // Spaces left hugging a line break come from the tags that were removed
    // around it, and they push a label away from its value.
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export { TRIP_ITEM_TYPES };
export type { ExtractedBooking };
