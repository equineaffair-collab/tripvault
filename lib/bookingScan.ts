/**
 * F5 Path A — scan a booking confirmation, entirely on the device.
 *
 * The same three steps F1 uses for a passport, pointed at a different document:
 * the native document scanner crops and deskews, ML Kit OCRs the result, and
 * lib/bookingParse reads what it can. Nothing leaves the phone, nothing costs
 * anything, and it works with no signal.
 *
 * A printed or PDF confirmation carries no schema.org markup and no calendar
 * file, so this always lands on the pattern tier and always comes back as low
 * confidence. That is the honest answer: the user confirms every field before
 * it is saved, and a form pre-filled with three of five fields is still much
 * better than an empty one.
 *
 * When the patterns find nothing at all, the caller can send the OCR text to
 * the `smart-import` function, which will try a model IF one is configured.
 * That is an optional extra, not a requirement — see lib/smartImport.ts.
 */
import { isMissingNativeModule, isScanningAvailable, ocrResultToLines } from './scan';
import { parseBooking, type ParseMethod } from './bookingParse';
import type { ExtractedBooking } from './smartImportFormat';

export type BookingScanResult =
  | { status: 'ok'; imageUri: string; text: string; booking: ExtractedBooking | null; method: ParseMethod | null }
  | { status: 'cancelled' }
  | { status: 'unavailable'; reason: 'no-dev-build' }
  | { status: 'error'; message: string };

function loadScanner(): any | null {
  try {
    const mod = require('react-native-document-scanner-plugin');
    const scan = mod?.default?.scanDocument ?? mod?.scanDocument ?? mod?.default;
    return typeof scan === 'function' ? scan : null;
  } catch {
    return null;
  }
}

function loadRecognizer(): any | null {
  try {
    const mod = require('@react-native-ml-kit/text-recognition');
    const recognize = mod?.default?.recognize ?? mod?.recognize;
    return typeof recognize === 'function' ? recognize : null;
  } catch {
    return null;
  }
}

/** OCR an image already on disk and read whatever booking is in it. */
export async function readBookingFromImage(imageUri: string): Promise<{
  text: string;
  booking: ExtractedBooking | null;
  method: ParseMethod | null;
}> {
  const recognize = loadRecognizer();
  if (!recognize) return { text: '', booking: null, method: null };

  const result = await recognize(imageUri);
  // Reusing F1's line splitter rather than its flat `text`: ML Kit's block tree
  // preserves layout, and a label and its value staying on one line is what
  // makes "Booking reference: ABC123" findable at all.
  const text = ocrResultToLines(result).join('\n');

  const parsed = parseBooking({ text });
  return { text, booking: parsed?.booking ?? null, method: parsed?.method ?? null };
}

/** Capture a confirmation and read it. */
export async function scanBooking(): Promise<BookingScanResult> {
  if (!isScanningAvailable()) return { status: 'unavailable', reason: 'no-dev-build' };

  const scan = loadScanner();
  if (!scan) return { status: 'unavailable', reason: 'no-dev-build' };

  try {
    const { scannedImages } = await scan({ maxNumDocuments: 1 });
    const imageUri = scannedImages?.[0];
    if (!imageUri) return { status: 'cancelled' };

    const { text, booking, method } = await readBookingFromImage(imageUri);
    return { status: 'ok', imageUri, text, booking, method };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // Same trap as F1: the JS wrapper exists in Expo Go even when its native
    // half does not, so a missing dev build surfaces here rather than as a
    // missing export. Report it as unavailable so the caller offers the manual
    // form instead of showing a TurboModule stack trace.
    if (isMissingNativeModule(message)) return { status: 'unavailable', reason: 'no-dev-build' };
    return { status: 'error', message };
  }
}
