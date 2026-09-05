/**
 * F1 — capture and read a document, entirely on the device.
 *
 * Three steps, none of which touch the network:
 *   1. react-native-document-scanner-plugin drives the native document scanner
 *      (Apple VisionKit / Google ML Kit), giving edge detection, deskew and crop
 *      rather than a plain photo.
 *   2. ML Kit text recognition OCRs the resulting image on-device.
 *   3. lib/mrz parses the machine-readable zone and validates its check digits.
 *
 * Both native modules need a dev build; Expo Go cannot load them. Rather than
 * crashing the whole app when they are absent, everything here is behind a lazy
 * require and reports unavailability, so the Documents screen still works and
 * offers manual entry. Same reasoning as F3's "Check entry requirements"
 * fallback: a missing capability degrades to a message, never to a crash.
 */
// Explicit file, not the directory: Metro resolves './mrz' but Node's ESM
// loader does not, and these modules are covered by `node --test`.
import { extractFromOcr, type MrzExtraction } from './mrz/index.ts';

export type ScanUnavailableReason = 'no-dev-build';

export type ScanResult =
  | { status: 'ok'; imageUri: string; extraction: MrzExtraction }
  | { status: 'cancelled' }
  | { status: 'unavailable'; reason: ScanUnavailableReason }
  | { status: 'error'; message: string };

/** Cached so a missing native module is probed once, not on every render. */
let scannerAvailable: boolean | null = null;
let recognizerAvailable: boolean | null = null;

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

/**
 * Whether on-device capture is usable right now. False in Expo Go and in any
 * build predating the native modules.
 */
export function isScanningAvailable(): boolean {
  if (scannerAvailable === null) scannerAvailable = loadScanner() !== null;
  if (recognizerAvailable === null) recognizerAvailable = loadRecognizer() !== null;
  return scannerAvailable && recognizerAvailable;
}

/**
 * Split ML Kit's result into lines. It exposes `text` with newlines and a
 * `blocks` tree; the tree preserves layout better, so prefer it and fall back
 * to splitting the flat string.
 */
export function ocrResultToLines(result: any): string[] {
  const fromBlocks: string[] = [];
  for (const block of result?.blocks ?? []) {
    for (const line of block?.lines ?? []) {
      if (typeof line?.text === 'string') fromBlocks.push(line.text);
    }
    // Some versions expose block text without a lines array.
    if (!block?.lines?.length && typeof block?.text === 'string') {
      fromBlocks.push(...block.text.split('\n'));
    }
  }
  if (fromBlocks.length > 0) return fromBlocks;

  return typeof result?.text === 'string' ? result.text.split('\n') : [];
}

/** Run OCR over an image already on disk, and parse any MRZ in it. */
export async function extractFromImage(imageUri: string): Promise<MrzExtraction> {
  const recognize = loadRecognizer();
  if (!recognize) {
    return {
      valid: false,
      format: null,
      lines: [],
      invalidFields: [],
      corrections: [],
      draft: null,
      error: 'On-device text recognition is not available in this build.',
    };
  }
  const result = await recognize(imageUri);
  return extractFromOcr(ocrResultToLines(result));
}

/**
 * Capture a document and read it. Returns the cropped image's local URI so the
 * caller can upload it after the document row exists (the storage path needs
 * the document id).
 */
export async function scanDocument(): Promise<ScanResult> {
  if (!isScanningAvailable()) {
    return { status: 'unavailable', reason: 'no-dev-build' };
  }

  const scan = loadScanner();
  if (!scan) return { status: 'unavailable', reason: 'no-dev-build' };

  try {
    const { scannedImages } = await scan({ maxNumDocuments: 1 });
    const imageUri = scannedImages?.[0];
    // The scanner resolves with nothing when the user backs out.
    if (!imageUri) return { status: 'cancelled' };

    return { status: 'ok', imageUri, extraction: await extractFromImage(imageUri) };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // The JS wrapper is present in Expo Go even when its native half is not, so
    // a missing dev build surfaces here as a call-time failure rather than a
    // missing export. Report it as unavailable so the caller offers manual
    // entry, instead of showing the user a TurboModule stack trace.
    if (isMissingNativeModule(message)) {
      scannerAvailable = false;
      return { status: 'unavailable', reason: 'no-dev-build' };
    }
    return { status: 'error', message };
  }
}

/** Recognise the several shapes React Native uses to say "no native module". */
export function isMissingNativeModule(message: string): boolean {
  return [
    /cannot find native module/i,
    /could not be found/i,
    /turbomoduleregistry/i,
    /requirenativemodule/i,
    /native module.*(null|not available|doesn't exist|does not exist)/i,
    /null is not an object.*nativemodules/i,
  ].some((pattern) => pattern.test(message));
}
