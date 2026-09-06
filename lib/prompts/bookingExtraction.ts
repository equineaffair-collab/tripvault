/**
 * F5 — the prompt for turning a booking confirmation into a trip item.
 *
 * Kept as its own file per the project conventions, so it can be read and
 * revised without opening the function that sends it.
 *
 * Used ONLY by the optional model fallback, and only for text lib/bookingParse
 * could not read. Most confirmations never reach it. F1's passport extraction
 * moved on-device because an MRZ is a fixed-width string with check digits; a
 * booking confirmation is genuinely unstructured prose in an arbitrary layout,
 * which is the case a language model is actually for.
 *
 * Two things the prompt is written to avoid, because both produce a wrong
 * booking that looks right:
 *   - guessing. A missing field must come back null, not inferred from context.
 *     The user confirms every field before it is saved, and a null they have to
 *     fill in is visible while a plausible invention is not.
 *   - marketing text. A confirmation email is mostly not the booking, and the
 *     provider named in the footer is often not the provider of the service.
 */

export const BOOKING_EXTRACTION_SYSTEM = `You read travel booking confirmations and return structured data.

Return ONLY a JSON object, with no prose and no code fence, of exactly this shape:

{
  "type": "flight" | "accommodation" | "car_hire" | "transfer" | "activity" | "other",
  "provider": string | null,
  "confirmationNumber": string | null,
  "itemDate": string | null,
  "amountDue": number | null,
  "dueDate": string | null,
  "notes": string | null,
  "confidence": "high" | "low"
}

Rules:
- If a field is not stated in the text, return null. Never infer, never guess,
  never carry a value over from a different booking in the same message.
- "itemDate" is when the thing happens - departure for a flight, check-in for a
  stay, pick-up for a car. ISO 8601. Include a time only if one is stated.
- "dueDate" and "amountDue" are for a balance still to be PAID. A booking that
  is already paid in full has both null. Do not put the total paid in
  "amountDue" - that field means money still owed.
- "provider" is who supplies the service (the airline, the hotel), not the
  booking site, not the sender of the email, and not a brand in the footer.
- "confirmationNumber" is the reference the traveller would quote. If several
  appear, prefer the one labelled as a booking or confirmation reference over
  a ticket, invoice or order number.
- "notes" is for something a traveller would want at the counter and that has
  no field of its own - a room type, a terminal, a baggage allowance. One or
  two short lines, or null. Not a summary of the email.
- Set "confidence" to "low" if the text does not clearly look like a booking
  confirmation, or if the type is a guess. Anything low is shown to the user as
  needing a check.
- Currency symbols and thousands separators must be stripped from "amountDue";
  return a plain number.`;

export function bookingExtractionUserMessage(text: string): string {
  return `Extract the booking from this message.\n\n---\n${text}\n---`;
}

/**
 * How much of a forwarded email is sent for extraction.
 *
 * A confirmation is near the top; what follows is legal boilerplate, unrelated
 * marketing and, in a forwarded chain, other people's messages. Truncating is
 * both cheaper and safer -- less of the user's mail leaves the system.
 */
export const MAX_EXTRACTION_CHARS = 8000;

export function trimForExtraction(text: string): string {
  const cleaned = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return cleaned.length <= MAX_EXTRACTION_CHARS
    ? cleaned
    : `${cleaned.slice(0, MAX_EXTRACTION_CHARS)}\n[truncated]`;
}
