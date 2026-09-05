/**
 * F1 — MRZ extraction, on-device.
 *
 * The pipeline is: the document scanner produces a deskewed crop -> ML Kit
 * OCRs it on-device -> this module locates the MRZ lines in that raw OCR text,
 * hands them to the `mrz` package for parsing and check-digit validation, and
 * maps the result onto the fields F1's confirm-or-correct form expects.
 *
 * Nothing here touches the network. See F1's design note in the feature plan
 * for why extraction is on-device rather than a hosted vision call.
 *
 * Kept as a single module with no internal imports so `node --test` can run it
 * directly under Node's native TypeScript stripping, with no test-runner
 * dependency.
 */
import { parse } from 'mrz';
import type { Details, MRZFormat } from 'mrz';

/** Line counts and widths for the MRZ formats ICAO 9303 defines. */
const LAYOUTS = [
  { format: 'TD1' as const, lines: 3, width: 30 },
  { format: 'TD2' as const, lines: 2, width: 36 },
  { format: 'TD3' as const, lines: 2, width: 44 },
];

/**
 * OCR routinely renders the filler '<' as a visually similar character. Every
 * character listed here is illegal in an MRZ, so mapping it to '<' cannot
 * destroy a real value.
 *
 * Genuinely ambiguous pairs (O/0, I/1, S/5, B/8) are deliberately NOT handled
 * here — both readings are legal, and which is correct depends on the field's
 * position. The `mrz` package resolves those per field with autocorrect,
 * constrained by check digits, which is strictly better than a blind replace.
 */
const FILLER_LOOKALIKES = new Set([
  '«', // «
  '»', // »
  '‹', // ‹
  '›', // ›
  '≪', // ≪
  '≫', // ≫
  '^',
  '~',
  '"',
  "'",
  '`',
  '|',
  '\\',
  '/',
  '[',
  ']',
  '{',
  '}',
  '(',
  ')',
  '_',
  '-',
  '–', // en dash
  '—', // em dash
  '.',
  ',',
  ':',
  ';',
]);

const LEGAL_MRZ_CHAR = /[A-Z0-9<]/;

export type MrzFieldName =
  | 'documentNumber'
  | 'expirationDate'
  | 'birthDate'
  | 'issuingState'
  | 'nationality'
  | 'lastName'
  | 'firstName'
  | 'sex'
  | 'documentCode';

export type DocumentType = 'passport' | 'visa' | 'id_card' | 'unknown';

export type DocumentDraft = {
  type: DocumentType;
  /** ICAO 3-letter issuing state, e.g. AUS. */
  country: string | null;
  documentNumber: string | null;
  /** ISO yyyy-mm-dd. */
  expiryDate: string | null;
  birthDate: string | null;
  nationality: string | null;
  lastName: string | null;
  firstName: string | null;
  sex: string | null;
};

export type MrzExtraction = {
  /** True only when every check digit in the document validated. */
  valid: boolean;
  format: MRZFormat | null;
  /** The normalized lines actually parsed, so the UI can show what was read. */
  lines: string[];
  /** Fields whose own check digit failed — surface these for review. */
  invalidFields: MrzFieldName[];
  /** Characters the parser corrected, so the UI can flag them for a closer look. */
  corrections: { field: string; from: string; to: string }[];
  draft: DocumentDraft | null;
  error: string | null;
};

/** Strip an OCR line down to the alphabet an MRZ can legally contain. */
export function normalizeLine(raw: string): string {
  let out = '';
  for (const ch of raw.toUpperCase()) {
    if (/\s/.test(ch)) continue;
    if (FILLER_LOOKALIKES.has(ch)) {
      out += '<';
    } else if (LEGAL_MRZ_CHAR.test(ch)) {
      out += ch;
    }
  }
  return out;
}

/**
 * A real MRZ line is mostly filler and digits. Requiring some '<' keeps
 * ordinary page text (the printed name, "PASSPORT", an authority name) from
 * being mistaken for an MRZ line that happens to be the right length.
 */
function looksLikeMrz(line: string, width: number): boolean {
  if (Math.abs(line.length - width) > 2) return false;
  return line.includes('<');
}

/** Pad or trim a nearly-right line to the exact width the format requires. */
function fit(line: string, width: number): string {
  if (line.length === width) return line;
  if (line.length < width) return line.padEnd(width, '<');
  return line.slice(0, width);
}

/**
 * Find the MRZ block inside arbitrary OCR output. OCR returns the whole page in
 * reading order, with no guarantee about what else it picked up, so this scans
 * for the first run of consecutive lines matching a known layout.
 *
 * TD1 is tried before TD3 so a 3-line 30-wide card is not partially matched.
 */
export function findMrzLines(
  ocrLines: readonly string[]
): { lines: string[]; format: MRZFormat } | null {
  const candidates = ocrLines.map(normalizeLine).filter((l) => l.length > 0);

  for (const layout of LAYOUTS) {
    for (let i = 0; i + layout.lines <= candidates.length; i++) {
      const window = candidates.slice(i, i + layout.lines);
      if (window.every((l) => looksLikeMrz(l, layout.width))) {
        return { lines: window.map((l) => fit(l, layout.width)), format: layout.format };
      }
    }
  }
  return null;
}

/**
 * MRZ dates are YYMMDD with no century. Which century is meant follows from
 * what the date is for: an expiry is near-future (passports run 10 years, and a
 * recently expired one is still plausible), a birth date is always past.
 */
export function mrzDateToIso(
  yymmdd: string | null | undefined,
  kind: 'past' | 'future',
  now: Date = new Date()
): string | null {
  if (!yymmdd || !/^\d{6}$/.test(yymmdd)) return null;

  const yy = Number(yymmdd.slice(0, 2));
  const mm = Number(yymmdd.slice(2, 4));
  const dd = Number(yymmdd.slice(4, 6));
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;

  const currentYear = now.getUTCFullYear();
  let year = Math.floor(currentYear / 100) * 100 + yy;

  if (kind === 'past') {
    // A birth date cannot be in the future.
    if (year > currentYear) year -= 100;
  } else {
    // An expiry is bounded much more tightly in one direction than the other.
    // A passport runs at most ten years, so an expiry can never be far in the
    // future -- but it can be arbitrarily far in the past, because people scan
    // old passports out of drawers. So the window is asymmetric: anything
    // beyond ten years ahead is the wrong century, while a date decades behind
    // is taken at face value until it becomes absurd.
    while (year > currentYear + 10) year -= 100;
    while (year < currentYear - 90) year += 100;
  }

  const iso = `${String(year).padStart(4, '0')}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
  // Reject impossible calendar dates (31 February) that passed the range check.
  const check = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(check.getTime()) || check.getUTCDate() !== dd) return null;
  return iso;
}

/** ICAO document codes: P passport, V visa, I/A/C identity card. */
export function documentTypeFromCode(code: string | null | undefined): DocumentType {
  if (!code) return 'unknown';
  const first = code.charAt(0).toUpperCase();
  if (first === 'P') return 'passport';
  if (first === 'V') return 'visa';
  if (first === 'I' || first === 'A' || first === 'C') return 'id_card';
  return 'unknown';
}

function collectInvalidFields(details: readonly Details[]): MrzFieldName[] {
  const out = new Set<MrzFieldName>();
  for (const d of details) {
    if (d.valid || !d.field) continue;
    // A failed check digit indicts the field it protects, not itself.
    out.add(d.field.replace(/CheckDigit$/, '') as MrzFieldName);
  }
  return [...out];
}

function collectCorrections(details: readonly Details[]) {
  const out: { field: string; from: string; to: string }[] = [];
  for (const d of details) {
    for (const c of d.autocorrect ?? []) {
      out.push({ field: d.field ?? d.label, from: c.original, to: c.corrected });
    }
  }
  return out;
}

/**
 * Full extraction from raw OCR output. Never throws: a scan that cannot be read
 * returns an error string for the UI, because the user always has the fallback
 * of entering the document by hand.
 */
export function extractFromOcr(
  ocrLines: readonly string[],
  now: Date = new Date()
): MrzExtraction {
  const empty: MrzExtraction = {
    valid: false,
    format: null,
    lines: [],
    invalidFields: [],
    corrections: [],
    draft: null,
    error: null,
  };

  const found = findMrzLines(ocrLines);
  if (!found) return { ...empty, error: 'No machine-readable zone found in this scan.' };

  let result;
  try {
    result = parse(found.lines, { autocorrect: true });
  } catch (e) {
    return {
      ...empty,
      lines: found.lines,
      error: e instanceof Error ? e.message : 'Could not read the machine-readable zone.',
    };
  }

  const f = result.fields;
  return {
    valid: result.valid,
    format: result.format,
    lines: found.lines,
    invalidFields: collectInvalidFields(result.details),
    corrections: collectCorrections(result.details),
    error: null,
    draft: {
      type: documentTypeFromCode(f.documentCode),
      country: f.issuingState ?? null,
      documentNumber: result.documentNumber ?? f.documentNumber ?? null,
      expiryDate: mrzDateToIso(f.expirationDate, 'future', now),
      birthDate: mrzDateToIso(f.birthDate, 'past', now),
      nationality: f.nationality ?? null,
      lastName: f.lastName ?? null,
      firstName: f.firstName ?? null,
      sex: f.sex ?? null,
    },
  };
}
