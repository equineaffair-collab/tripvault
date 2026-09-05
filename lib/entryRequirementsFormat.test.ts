/**
 * F6 — tests for the validity comparison.
 *
 * The test plan's F6 section asks for three things specifically: the
 * multi-passport recommendation, the disclaimer showing every time, and
 * unverified data not being treated as equivalent to verified. It also asks
 * that no visa determination happens anywhere — asserted here by checking the
 * output never mentions one.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkPassports,
  disclaimerFor,
  requiredValidUntil,
  type EntryRequirement,
  type PassportForCheck,
} from './entryRequirementsFormat.ts';

const rule = (over: Partial<EntryRequirement> = {}): EntryRequirement => ({
  country: 'THA',
  countryName: 'Thailand',
  minPassportValidityMonths: 6,
  countedFrom: 'entry',
  verified: false,
  lastVerified: null,
  notes: null,
  ...over,
});

const passport = (
  id: string,
  expiryDate: string | null,
  country = 'AUS',
  isPrimary = false
): PassportForCheck => ({ id, country, expiryDate, isPrimary });

const trip = { startDate: '2027-04-01', endDate: '2027-04-14' };

describe('requiredValidUntil', () => {
  test('an entry rule counts from arrival', () => {
    assert.equal(requiredValidUntil(rule(), trip), '2027-10-01');
  });

  test('an exit rule counts from departure', () => {
    // Not a rounding difference: on a long trip the two answers diverge by the
    // whole length of the stay.
    assert.equal(
      requiredValidUntil(rule({ countedFrom: 'exit', minPassportValidityMonths: 3 }), trip),
      '2027-07-14'
    );
  });

  test('a zero-month rule resolves to the travel date itself', () => {
    assert.equal(
      requiredValidUntil(rule({ minPassportValidityMonths: 0, countedFrom: 'exit' }), trip),
      '2027-04-14'
    );
  });

  test('returns null when the trip has no relevant date', () => {
    assert.equal(requiredValidUntil(rule(), { startDate: null, endDate: null }), null);
  });
});

describe('checkPassports — single passport', () => {
  test('a passport with plenty of validity clears', () => {
    const result = checkPassports({
      requirement: rule(),
      passports: [passport('p1', '2030-01-01')],
      trip,
    });
    assert.equal(result.anyClears, true);
    assert.equal(result.recommended?.passportId, 'p1');
    assert.equal(result.verdicts[0].reason, 'ok');
  });

  test('a passport expiring inside the window is flagged', () => {
    const result = checkPassports({
      requirement: rule(),
      passports: [passport('p1', '2027-08-01')],
      trip,
    });
    assert.equal(result.anyClears, false);
    assert.equal(result.verdicts[0].reason, 'expires-too-soon');
    assert.equal(result.recommended, null);
  });

  test('a passport expiring before the trip ends is a different, worse reason', () => {
    const result = checkPassports({
      requirement: rule(),
      passports: [passport('p1', '2027-04-05')],
      trip,
    });
    assert.equal(result.verdicts[0].reason, 'expires-before-travel');
  });

  test('a passport with no expiry recorded is not silently passed', () => {
    const result = checkPassports({
      requirement: rule(),
      passports: [passport('p1', null)],
      trip,
    });
    assert.equal(result.verdicts[0].reason, 'no-expiry-recorded');
    assert.equal(result.anyClears, false);
  });

  test('exactly on the required date clears', () => {
    const result = checkPassports({
      requirement: rule(),
      passports: [passport('p1', '2027-10-01')],
      trip,
    });
    assert.equal(result.anyClears, true);
  });
});

describe('checkPassports — dual nationality', () => {
  test('recommends the passport that clears when the other does not', () => {
    const result = checkPassports({
      requirement: rule(),
      passports: [passport('p1', '2027-08-01', 'AUS', true), passport('p2', '2031-01-01', 'LVA')],
      trip,
    });
    assert.equal(result.anyClears, true);
    assert.equal(result.recommended?.passportId, 'p2');
    assert.match(result.recommendationReason, /LVA/);
  });

  test('when both clear, prefers the one lasting longest', () => {
    const result = checkPassports({
      requirement: rule(),
      passports: [passport('p1', '2029-01-01', 'AUS', true), passport('p2', '2031-01-01', 'LVA')],
      trip,
    });
    assert.equal(result.recommended?.passportId, 'p2');
  });

  test('a tie goes to the traveler\'s own primary', () => {
    const result = checkPassports({
      requirement: rule(),
      passports: [passport('p1', '2031-01-01', 'AUS', true), passport('p2', '2031-01-01', 'LVA')],
      trip,
    });
    assert.equal(result.recommended?.passportId, 'p1');
  });

  test('reports every passport, not just the recommended one', () => {
    const result = checkPassports({
      requirement: rule(),
      passports: [passport('p1', '2027-08-01'), passport('p2', '2031-01-01')],
      trip,
    });
    assert.equal(result.verdicts.length, 2);
  });

  test('when neither clears, there is no recommendation and it says so', () => {
    const result = checkPassports({
      requirement: rule(),
      passports: [passport('p1', '2027-08-01'), passport('p2', '2027-09-01')],
      trip,
    });
    assert.equal(result.recommended, null);
    assert.match(result.recommendationReason, /None of the passports/);
  });
});

describe('unverified data is not treated as verified', () => {
  test('an unverified rule says so before anything else', () => {
    const text = disclaimerFor(rule({ verified: false }));
    assert.match(text, /hasn't been verified/);
    assert.match(text, /prompt to check rather than an answer/);
  });

  test('a verified rule states when it was checked', () => {
    const text = disclaimerFor(rule({ verified: true, lastVerified: '2026-09-01' }));
    assert.match(text, /Last verified 2026-09-01/);
    assert.ok(!/hasn't been verified/.test(text));
  });

  test('both wordings still carry the embassy disclaimer', () => {
    // F6 is advisory only, and the ToS brief treats that as a liability point.
    for (const verified of [true, false]) {
      const text = disclaimerFor(
        rule({ verified, lastVerified: verified ? '2026-09-01' : null })
      );
      assert.match(text, /embassy or consulate/);
    }
  });
});

describe('F6 makes no visa determination', () => {
  test('nothing in the output mentions a visa', () => {
    // The deliberate F6/F7 split: F6 answers validity only. If visa wording ever
    // appears here, the two features have started merging back together.
    const result = checkPassports({
      requirement: rule({ notes: 'Six months beyond arrival.' }),
      passports: [passport('p1', '2030-01-01'), passport('p2', '2027-08-01')],
      trip,
    });

    const text = [
      result.recommendationReason,
      disclaimerFor(result.requirement),
      ...result.verdicts.map((v) => v.reason),
    ]
      .join(' ')
      .toLowerCase();

    assert.ok(!text.includes('visa'), `visa wording leaked into F6: ${text}`);
  });

  test('the requirement type has no visa field at all', () => {
    const r = rule();
    assert.ok(!('visaRequired' in r));
    assert.ok(!('visa' in r));
  });
});
