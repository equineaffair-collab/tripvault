/**
 * F1 — MRZ extraction tests.
 *
 * Run with:  npm test
 *
 * These use the specimen MRZ strings from ICAO Doc 9303 (the "UTOPIA / ERIKSSON"
 * examples), whose check digits are correct by construction — so a failure here
 * is a real defect in our parsing, not a bad fixture.
 *
 * This is the half of F1's extraction that can be verified without a device:
 * line-finding, century windowing, field mapping and check-digit handling are
 * pure functions. The OCR step itself needs a real build and a real passport.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  documentTypeFromCode,
  extractFromOcr,
  findMrzLines,
  mrzDateToIso,
  normalizeLine,
} from './index.ts';

// ICAO 9303 part 4 specimen, TD3 (passport): 2 lines of 44.
//
// The spec's own sample issues from "UTO" (Utopia), which the mrz package
// rejects as not a real ICAO state code. Substituted with AUS: the issuing
// state and nationality fields sit outside every check digit's range -- line 1
// has no check digit at all, and the composite digit covers the document
// number, dates and personal number but not nationality -- so the specimen's
// checksums remain correct by construction.
const TD3 = [
  'P<AUSERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<',
  'L898902C36AUS7408122F1204159ZE184226B<<<<<10',
];

// ICAO 9303 part 5 specimen, TD1 (identity card): 3 lines of 30. Same AUS
// substitution, for the same reason.
const TD1 = [
  'I<AUSD231458907<<<<<<<<<<<<<<<',
  '7408122F1204159AUS<<<<<<<<<<<6',
  'ERIKSSON<<ANNA<MARIA<<<<<<<<<<',
];

// A fixed "today" so century windowing is deterministic across runs.
const NOW = new Date('2026-09-05T00:00:00Z');

describe('fixtures are the right shape', () => {
  test('TD3 lines are 44 characters', () => {
    for (const l of TD3) assert.equal(l.length, 44);
  });
  test('TD1 lines are 30 characters', () => {
    for (const l of TD1) assert.equal(l.length, 30);
  });
});

describe('normalizeLine', () => {
  test('uppercases and strips spaces', () => {
    assert.equal(normalizeLine('p<uto eriksson'), 'P<UTOERIKSSON');
  });

  test('maps filler lookalikes to <', () => {
    // OCR commonly returns « or ‹ or a run of dashes where the filler is.
    assert.equal(normalizeLine('P«UTO'), 'P<UTO');
    assert.equal(normalizeLine('P---UTO'), 'P<<<UTO');
  });

  test('drops characters that are illegal in an MRZ', () => {
    assert.equal(normalizeLine('P✓UTO#'), 'PUTO');
  });

  test('leaves ambiguous O/0 and I/1 alone for the parser to resolve', () => {
    // Blind global correction here would destroy real values; the mrz package
    // resolves these per field, constrained by check digits.
    assert.equal(normalizeLine('O0I1S5B8'), 'O0I1S5B8');
  });
});

describe('findMrzLines', () => {
  test('finds a TD3 block surrounded by other page text', () => {
    const ocr = [
      'PASSPORT',
      'AUSTRALIA',
      'Surname / Nom',
      'ERIKSSON',
      ...TD3,
    ];
    const found = findMrzLines(ocr);
    assert.ok(found);
    assert.equal(found.format, 'TD3');
    assert.deepEqual(found.lines, TD3);
  });

  test('finds a TD1 block', () => {
    const found = findMrzLines(['IDENTITY CARD', ...TD1]);
    assert.ok(found);
    assert.equal(found.format, 'TD1');
    assert.deepEqual(found.lines, TD1);
  });

  test('pads a line the OCR clipped short', () => {
    // Trailing filler carries no visual structure, so OCR drops it often.
    const clipped = [TD3[0].slice(0, 42), TD3[1]];
    const found = findMrzLines(clipped);
    assert.ok(found);
    assert.equal(found.lines[0].length, 44);
    assert.equal(found.lines[0], TD3[0]);
  });

  test('returns null when there is no MRZ', () => {
    assert.equal(findMrzLines(['PASSPORT', 'AUSTRALIA', 'ERIKSSON']), null);
  });

  test('does not mistake ordinary text of the right length for an MRZ', () => {
    // 44 characters, no filler — must not be accepted.
    const decoy = 'THISLINEISEXACTLYFORTYFOURCHARACTERSLONGXXXX';
    assert.equal(decoy.length, 44);
    assert.equal(findMrzLines([decoy, decoy]), null);
  });
});

describe('mrzDateToIso', () => {
  test('reads an expiry as near-future', () => {
    assert.equal(mrzDateToIso('300115', 'future', NOW), '2030-01-15');
  });

  test('reads a birth date as past', () => {
    assert.equal(mrzDateToIso('740812', 'past', NOW), '1974-08-12');
  });

  test('a two-digit birth year before the current year stays in this century', () => {
    assert.equal(mrzDateToIso('100301', 'past', NOW), '2010-03-01');
  });

  test('a birth year that would be in the future rolls back a century', () => {
    // "99" in 2026 means 1999, not 2099.
    assert.equal(mrzDateToIso('990101', 'past', NOW), '1999-01-01');
  });

  test('a near-future expiry rolls forward across a century boundary', () => {
    // In 2098 a valid passport expires 2098-2108, so "05" means 2105.
    const in2098 = new Date('2098-06-01T00:00:00Z');
    assert.equal(mrzDateToIso('050115', 'future', in2098), '2105-01-15');
  });

  test('an expiry decades in the past is taken at face value', () => {
    // People scan old passports out of drawers. In 2098, "32" is a passport
    // that expired in 2032 -- not one expiring in 2132, which no ten-year
    // document could do.
    const in2098 = new Date('2098-06-01T00:00:00Z');
    assert.equal(mrzDateToIso('320115', 'future', in2098), '2032-01-15');
  });

  test('the ICAO specimen expiry stays in its own century', () => {
    // The specimen expired in 2012, fourteen years before NOW. An expiry can
    // be arbitrarily far behind; only the future side is bounded.
    assert.equal(mrzDateToIso('120415', 'future', NOW), '2012-04-15');
  });

  test('a two-digit year too far ahead to be real drops a century', () => {
    // A passport runs at most ten years, so "95" read in 2026 is 1995.
    assert.equal(mrzDateToIso('950115', 'future', NOW), '1995-01-15');
  });

  test('a recently expired passport is not pushed a century forward', () => {
    assert.equal(mrzDateToIso('240115', 'future', NOW), '2024-01-15');
  });

  test('rejects an impossible calendar date', () => {
    assert.equal(mrzDateToIso('740231', 'past', NOW), null);
  });

  test('rejects a malformed value', () => {
    assert.equal(mrzDateToIso('74081', 'past', NOW), null);
    assert.equal(mrzDateToIso('7408AB', 'past', NOW), null);
    assert.equal(mrzDateToIso(null, 'past', NOW), null);
  });
});

describe('documentTypeFromCode', () => {
  test('maps ICAO codes', () => {
    assert.equal(documentTypeFromCode('P'), 'passport');
    assert.equal(documentTypeFromCode('P<'), 'passport');
    assert.equal(documentTypeFromCode('V'), 'visa');
    assert.equal(documentTypeFromCode('ID'), 'id_card');
    assert.equal(documentTypeFromCode('AC'), 'id_card');
    assert.equal(documentTypeFromCode('X'), 'unknown');
    assert.equal(documentTypeFromCode(null), 'unknown');
  });
});

describe('extractFromOcr — TD3 passport', () => {
  const result = extractFromOcr(['PASSPORT', ...TD3], NOW);

  test('every check digit validates on a clean specimen', () => {
    assert.equal(result.error, null);
    assert.equal(result.valid, true, `invalid fields: ${result.invalidFields.join(', ')}`);
    assert.deepEqual(result.invalidFields, []);
  });

  test('identifies the format', () => {
    assert.equal(result.format, 'TD3');
  });

  test('maps the fields F1 stores', () => {
    const d = result.draft;
    assert.ok(d);
    assert.equal(d.type, 'passport');
    assert.equal(d.documentNumber, 'L898902C3');
    assert.equal(d.country, 'AUS');
    assert.equal(d.nationality, 'AUS');
    assert.equal(d.expiryDate, '2012-04-15');
    assert.equal(d.birthDate, '1974-08-12');
    assert.equal(d.sex, 'female');
    assert.equal(d.lastName, 'ERIKSSON');
    assert.equal(d.firstName, 'ANNA MARIA');
  });
});

describe('extractFromOcr — TD1 identity card', () => {
  const result = extractFromOcr(TD1, NOW);

  test('parses a 3-line card', () => {
    assert.equal(result.error, null);
    assert.equal(result.format, 'TD1');
    assert.equal(result.valid, true, `invalid fields: ${result.invalidFields.join(', ')}`);
    assert.equal(result.draft?.type, 'id_card');
    assert.equal(result.draft?.documentNumber, 'D23145890');
  });
});

describe('extractFromOcr — bad input', () => {
  test('a scan with no MRZ reports an error rather than throwing', () => {
    const r = extractFromOcr(['JUST', 'SOME', 'TEXT'], NOW);
    assert.equal(r.draft, null);
    assert.match(r.error ?? '', /no machine-readable zone/i);
  });

  test('a corrupted check digit is caught, not silently accepted', () => {
    // Change the document number's check digit from 6 to 5. This is the whole
    // point of reading the MRZ rather than the printed page: a misread is
    // detectable arithmetic, not a judgement call.
    const corrupted = [TD3[0], TD3[1].slice(0, 9) + '5' + TD3[1].slice(10)];
    const r = extractFromOcr(corrupted, NOW);
    assert.equal(r.valid, false);
    assert.ok(
      r.invalidFields.includes('documentNumber'),
      `expected documentNumber flagged, got: ${r.invalidFields.join(', ')}`
    );
  });

  test('a draft is still returned when a check digit fails, for correction', () => {
    // The user confirms every field anyway, so a partial read is more useful
    // than nothing -- it just must not claim to be valid.
    const corrupted = [TD3[0], TD3[1].slice(0, 9) + '5' + TD3[1].slice(10)];
    const r = extractFromOcr(corrupted, NOW);
    assert.ok(r.draft);
    assert.equal(r.valid, false);
  });
});
