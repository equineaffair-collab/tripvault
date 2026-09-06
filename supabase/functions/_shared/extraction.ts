/**
 * F5 — turning booking text into a trip item, behind a provider seam.
 *
 * The seam is the point. No Anthropic key is configured on this project, and
 * the honest response to that is not to fail: it is to record what arrived and
 * read it later, the same trade F2 makes by writing a reminder row before it
 * can be delivered. So `extractBooking` returns a status rather than throwing,
 * and 'unconfigured' is a first-class outcome the callers are written around.
 *
 * Configure with:
 *   supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
 *
 * The prompt and the parsing both come from lib/, unchanged, so the rules a
 * forwarded email is held to are the same ones a photo scanned in the app is
 * held to. Two copies of that logic would drift, and the drift would show up as
 * "it works when I scan it but not when I forward it".
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

export type ExtractionOutcome =
  | { status: 'extracted'; booking: ExtractedBooking }
  | { status: 'unreadable'; detail: string }
  | { status: 'unconfigured'; detail: string }
  | { status: 'failed'; detail: string };

/** The model to use. Pinned, so a silent upgrade cannot change extraction behaviour. */
const MODEL = 'claude-sonnet-5';

export function isExtractionConfigured(): boolean {
  return Boolean(Deno.env.get('ANTHROPIC_API_KEY'));
}

export async function extractBooking(text: string): Promise<ExtractionOutcome> {
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');

  if (!apiKey) {
    return {
      status: 'unconfigured',
      detail: 'Booking extraction is not switched on yet.',
    };
  }

  const trimmed = trimForExtraction(text);
  if (!trimmed) {
    return { status: 'unreadable', detail: 'There was no text to read.' };
  }

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
        messages: [{ role: 'user', content: bookingExtractionUserMessage(trimmed) }],
      }),
    });
  } catch (e) {
    // A network failure is 'failed', never 'unreadable'. The difference matters
    // to the user: one is worth retrying, the other means the email was not a
    // booking, and conflating them would have people re-forwarding mail that is
    // never going to work.
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
  const raw = content?.find((c) => c.type === 'text')?.text ?? '';

  const booking = parseExtractedBooking(safeJson(raw));

  if (!isUsableExtraction(booking)) {
    return {
      status: 'unreadable',
      detail: "This didn't look like a booking confirmation, so nothing was added.",
    };
  }

  return { status: 'extracted', booking: booking as ExtractedBooking };
}

/**
 * The prompt asks for bare JSON, and the model usually obliges. `usually` is
 * why the fence is stripped anyway -- one stray code fence should not lose a
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
