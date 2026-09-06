/**
 * F5 — tests for extraction handling and trip suggestion.
 *
 * Everything here guards the same failure: a wrong booking that looks right.
 * A model's output is untrusted input, and the tests are written from that
 * position rather than from "does the happy path work".
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  FORWARDING_ADDRESS_NOTE,
  HOLDING_AREA_NOTE,
  describeInbound,
  forwardingAddress,
  holdingAreaSummary,
  isUsableExtraction,
  isoDateOrNull,
  isoDateTimeOrNull,
  parseExtractedBooking,
  suggestTrip,
  type TripWindow,
} from './smartImportFormat.ts';
import { MAX_EXTRACTION_CHARS, trimForExtraction } from './prompts/bookingExtraction.ts';

const good = {
  type: 'flight',
  provider: 'Qantas',
  confirmationNumber: 'ABC123',
  itemDate: '2027-03-14T09:20:00Z',
  amountDue: null,
  dueDate: null,
  notes: 'Terminal 1',
  confidence: 'high',
};

describe('parsing what the model returned', () => {
  test('a clean result comes through intact', () => {
    const b = parseExtractedBooking(good);
    assert.equal(b?.type, 'flight');
    assert.equal(b?.provider, 'Qantas');
    assert.equal(b?.confirmationNumber, 'ABC123');
    assert.equal(b?.confidence, 'high');
  });

  test('an unknown type becomes "other" rather than reaching the database', () => {
    // trip_items has a CHECK constraint on type. An invented value would fail
    // the whole insert and lose an otherwise good booking.
    assert.equal(parseExtractedBooking({ ...good, type: 'helicopter' })?.type, 'other');
  });

  test('confidence defaults to low when it is anything but "high"', () => {
    // The default has to fall on the side of "check this".
    for (const value of [undefined, null, 'medium', 'HIGH', 42]) {
      assert.equal(parseExtractedBooking({ ...good, confidence: value })?.confidence, 'low');
    }
  });

  test('a nonsense amount becomes null, not NaN', () => {
    for (const value of ['$412.00', NaN, Infinity, -5, {}]) {
      assert.equal(parseExtractedBooking({ ...good, amountDue: value })?.amountDue, null);
    }
  });

  test('a real amount is rounded to cents', () => {
    assert.equal(parseExtractedBooking({ ...good, amountDue: 412.005 })?.amountDue, 412.01);
  });

  test('junk input is refused outright', () => {
    for (const value of [null, undefined, 'a string', 42]) {
      assert.equal(parseExtractedBooking(value), null);
    }
  });

  test('nothing is repaired — a bad date becomes null', () => {
    // Repairing would be invisible to whoever confirms the form at a glance.
    assert.equal(parseExtractedBooking({ ...good, itemDate: 'next Tuesday' })?.itemDate, null);
  });
});

describe('dates', () => {
  test('a plain date passes through', () => {
    assert.equal(isoDateOrNull('2027-03-14'), '2027-03-14');
  });

  test('an impossible date is refused, not rolled forward', () => {
    // Date() turns 2027-02-31 into 3 March. Silently moving a booking by two
    // days is exactly the kind of wrong that never gets noticed.
    assert.equal(isoDateOrNull('2027-02-31'), null);
    assert.equal(isoDateOrNull('2027-13-01'), null);
  });

  test('a leap day in a leap year survives', () => {
    assert.equal(isoDateOrNull('2028-02-29'), '2028-02-29');
    assert.equal(isoDateOrNull('2027-02-29'), null);
  });

  test('a date with no time becomes midnight rather than nothing', () => {
    assert.equal(isoDateTimeOrNull('2027-03-14'), '2027-03-14T00:00:00.000Z');
  });

  test('a stated time is kept', () => {
    assert.match(String(isoDateTimeOrNull('2027-03-14T09:20:00Z')), /T09:20/);
  });

  test('free text is not coerced into a date', () => {
    assert.equal(isoDateTimeOrNull('sometime in March'), null);
    assert.equal(isoDateTimeOrNull(''), null);
  });
});

describe('whether an extraction is worth using', () => {
  test('a result with a provider, a reference or a date is usable', () => {
    assert.ok(isUsableExtraction(parseExtractedBooking(good)));
    assert.ok(
      isUsableExtraction(
        parseExtractedBooking({ ...good, provider: null, confirmationNumber: null })
      )
    );
  });

  test('a result with none of the three is not', () => {
    // The model being polite about a marketing email, not a booking.
    const empty = parseExtractedBooking({
      ...good,
      provider: null,
      confirmationNumber: null,
      itemDate: null,
    });
    assert.equal(isUsableExtraction(empty), false);
  });
});

describe('suggesting a trip', () => {
  const trips: TripWindow[] = [
    { id: 'a', name: 'Japan', startDate: '2027-03-01', endDate: '2027-03-20' },
    { id: 'b', name: 'Bali', startDate: '2027-07-01', endDate: '2027-07-14' },
  ];

  test('a date inside exactly one trip suggests it', () => {
    const s = suggestTrip('2027-03-14T09:20:00Z', trips);
    assert.equal(s?.tripId, 'a');
    assert.match(s?.reason ?? '', /2027-03-14/);
  });

  test('the last day of a trip still counts', () => {
    // A return flight is on the end date. Excluding it would push exactly the
    // bookings people care most about into the holding area.
    assert.equal(suggestTrip('2027-03-20T22:00:00Z', trips)?.tripId, 'a');
  });

  test('a date outside every trip suggests nothing', () => {
    assert.equal(suggestTrip('2027-05-01T00:00:00Z', trips), null);
  });

  test('two overlapping trips suggest nothing rather than picking one', () => {
    // Ambiguity is when a confident guess is most likely to be wrong and least
    // likely to be checked.
    const overlapping = [
      ...trips,
      { id: 'c', name: 'Work trip', startDate: '2027-03-10', endDate: '2027-03-16' },
    ];
    assert.equal(suggestTrip('2027-03-14T09:20:00Z', overlapping), null);
  });

  test('no date means no suggestion', () => {
    assert.equal(suggestTrip(null, trips), null);
  });

  test('a trip with no dates at all is never suggested', () => {
    assert.equal(suggestTrip('2027-03-14', [{ id: 'z', name: 'Someday', startDate: null, endDate: null }]), null);
  });

  test('a trip with only a start date still works', () => {
    const openEnded = [{ id: 'y', name: 'Sabbatical', startDate: '2027-01-01', endDate: null }];
    assert.equal(suggestTrip('2027-06-01', openEnded)?.tripId, 'y');
    assert.equal(suggestTrip('2026-06-01', openEnded), null);
  });
});

describe('wording', () => {
  test('the pending state says why nothing has happened', () => {
    // The honest state today: mail arrives and waits for a provider. Silence
    // would read as the feature being broken.
    assert.match(describeInbound('pending'), /not switched on yet/);
  });

  test('a tier refusal says the email was kept', () => {
    // Dropping someone's forwarded mail because their plan lapsed would be
    // worse than holding it.
    assert.match(describeInbound('rejected_tier'), /kept/);
  });

  test('a failure offers a retry rather than a dead end', () => {
    assert.match(describeInbound('failed'), /retried/);
  });

  test('a supplied detail wins over the generic wording', () => {
    assert.equal(describeInbound('unreadable', 'No booking reference anywhere.'), 'No booking reference anywhere.');
  });

  test('the holding area counts correctly, including the singular', () => {
    assert.match(holdingAreaSummary(0), /Nothing waiting/);
    assert.equal(holdingAreaSummary(1), '1 booking needs a trip.');
    assert.equal(holdingAreaSummary(3), '3 bookings need a trip.');
  });

  test('the address note says it is a credential', () => {
    assert.match(FORWARDING_ADDRESS_NOTE, /like a password/);
    assert.match(FORWARDING_ADDRESS_NOTE, /Replace it/);
  });

  test('the holding area explains why it exists', () => {
    assert.match(HOLDING_AREA_NOTE, /you were in your inbox/);
  });

  test('an address is assembled correctly', () => {
    assert.equal(forwardingAddress('tvabc', 'trips.example.com'), 'tvabc@trips.example.com');
    assert.equal(forwardingAddress('tvabc', '@trips.example.com'), 'tvabc@trips.example.com');
  });
});

describe('what gets sent for extraction', () => {
  test('a short message goes as-is', () => {
    assert.equal(trimForExtraction('  Booking confirmed\n\n\n\nRef 123 '), 'Booking confirmed\n\nRef 123');
  });

  test('a long one is truncated and says so', () => {
    // Less of the user's mail leaving the system is the point, not the tokens.
    const long = trimForExtraction('x'.repeat(MAX_EXTRACTION_CHARS + 5000));
    assert.ok(long.length < MAX_EXTRACTION_CHARS + 100);
    assert.match(long, /\[truncated\]$/);
  });
});
