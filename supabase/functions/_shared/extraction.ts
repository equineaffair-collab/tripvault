/**
 * F5 — turning booking text into a trip item.
 *
 * Rewritten 2026-09-07. It used to be a Claude API call with a stub for "no key
 * configured"; it is now a deterministic parser with the model as an OPTIONAL
 * fallback behind it. The reasoning is in lib/bookingParse.ts, and it is the
 * same reasoning that moved F1 on-device: most real confirmations carry
 * machine-readable data — schema.org markup, a calendar attachment — put there
 * by the airline or hotel precisely so software can read them without guessing.
 *
 * Consequences worth knowing:
 *   - There is no configuration this feature REQUIRES any more. Extraction runs
 *     on every message, immediately, at no cost.
 *   - `ANTHROPIC_API_KEY` is now a genuine optional extra. Set it and messages
 *     the parser could not read are passed to a model as a second attempt. Leave
 *     it unset and those messages land in the form for the user to complete,
 *     which is where a failed model call would have left them anyway.
 *   - The model never overrides the parser. It only ever sees what the parser
 *     could not read, so an exact answer is never replaced by an inferred one.
 *
 * Optional:
 *   supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
 */
import {
  BOOKING_EXTRACTION_SYSTEM,
  bookingExtractionUserMessage,
  trimForExtraction,
} from '../../../lib/prompts/bookingExtraction.ts';
import {
  isUsableExtraction,
  parseExtractedBooking,
  type ExtractedBooking,
} from '../../../lib/smartImportFormat.ts';
import { parseBooking, stripTags, type ParseInput, type ParseMethod } from '../../../lib/bookingParse.ts';

/** How the booking was read. Recorded so a bad item can be traced to a method. */
export type ExtractionMethod = ParseMethod | 'model';

export type ExtractionOutcome =
  | { status: 'extracted'; booking: ExtractedBooking; method: ExtractionMethod }
  | { status: 'unreadable'; detail: string }
  | { status: 'failed'; detail: string };

/** Pinned, so a silent upgrade cannot change extraction behaviour. */
const MODEL = 'claude-sonnet-5';

/** Whether the optional model fallback is available. Not required for anything. */
export function isModelFallbackConfigured(): boolean {
  return Boolean(Deno.env.get('ANTHROPIC_API_KEY'));
}

export async function extractBooking(input: ParseInput): Promise<ExtractionOutcome> {
  // 1. Deterministic. Free, instant, and exact when the message carries markup.
  const parsed = parseBooking(input);
  if (parsed && isUsableExtraction(parsed.booking)) {
    return { status: 'extracted', booking: parsed.booking, method: parsed.method };
  }

  // 2. A model, only if one is configured, and only on what tier 3 could not
  //    read. Nothing exact is ever handed to it for a second opinion.
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) {
    return {
      status: 'unreadable',
      detail: "This didn't look like a booking confirmation, so nothing was added.",
    };
  }

  const text = textFor(input);
  if (!text.trim()) {
    return { status: 'unreadable', detail: 'There was no text to read.' };
  }

  return await askModel(apiKey, text);
}

function textFor(input: ParseInput): string {
  const parts = [input.subject, input.text, input.html ? stripTags(input.html) : null];
  return trimForExtraction(parts.filter(Boolean).join('\n'));
}

async function askModel(apiKey: string, text: string): Promise<ExtractionOutcome> {
  let response: Response;
  try {
    response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        system: BOOKING_EXTRACTION_SYSTEM,
        messages: [{ role: 'user', content: bookingExtractionUserMessage(text) }],
      }),
    });
  } catch (e) {
    // A network failure is 'failed', never 'unreadable'. The difference matters
    // to the user: one is worth retrying, the other means the message was not a
    // booking, and conflating them has people re-forwarding mail that will
    // never work.
    return { status: 'failed', detail: describeError(e) };
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    console.error('extraction call failed', response.status, body.slice(0, 500));
    return { status: 'failed', detail: `The extraction service returned ${response.status}.` };
  }

  let payload: Record<string, unknown>;
  try {
    payload = await response.json();
  } catch (e) {
    return { status: 'failed', detail: describeError(e) };
  }

  const content = payload.content as { type: string; text?: string }[] | undefined;
  const booking = parseExtractedBooking(safeJson(content?.find((c) => c.type === 'text')?.text ?? ''));

  if (!isUsableExtraction(booking)) {
    return {
      status: 'unreadable',
      detail: "This didn't look like a booking confirmation, so nothing was added.",
    };
  }

  return { status: 'extracted', booking: booking as ExtractedBooking, method: 'model' };
}

/**
 * The prompt asks for bare JSON, and the model usually obliges. `usually` is
 * why the fence is stripped anyway — one stray code fence should not lose a
 * booking that was read correctly.
 */
function safeJson(text: string): unknown {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

function describeError(e: unknown): string {
  return e instanceof Error ? e.message : 'Unknown error';
}
