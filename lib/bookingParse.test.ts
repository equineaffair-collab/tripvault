/**
 * F5 — tests for reading a booking without a model.
 *
 * The fixtures are shaped like the real thing: a Qantas-style confirmation with
 * Google email markup, a hotel with a calendar attachment, and a small vendor
 * that ships neither. Every test here is really asking one of two questions —
 * did it read what was actually stated, and did it refuse to invent what was
 * not.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseBooking, stripTags } from './bookingParse.ts';

const jsonLd = (payload: unknown) =>
  `<html><body><p>Your booking is confirmed.</p>` +
  `<script type="application/ld+json">${JSON.stringify(payload)}</script>` +
  `</body></html>`;

const FLIGHT = {
  '@context': 'http://schema.org',
  '@type': 'FlightReservation',
  reservationNumber: 'ZZ9ABC',
  reservationStatus: 'http://schema.org/ReservationConfirmed',
  underName: { '@type': 'Person', name: 'Janette' },
  reservationFor: {
    '@type': 'Flight',
    flightNumber: '1',
    airline: { '@type': 'Airline', name: 'Qantas', iataCode: 'QF' },
    departureAirport: { '@type': 'Airport', iataCode: 'SYD' },
    arrivalAirport: { '@type': 'Airport', iataCode: 'LHR' },
    departureTime: '2027-03-14T09:20:00+11:00',
  },
};

describe('schema.org markup — the exact path', () => {
  test('a flight confirmation is read exactly', () => {
    const r = parseBooking({ html: jsonLd(FLIGHT) });
    assert.equal(r?.method, 'json-ld');
    assert.equal(r?.booking.type, 'flight');
    assert.equal(r?.booking.provider, 'Qantas');
    assert.equal(r?.booking.confirmationNumber, 'ZZ9ABC');
    assert.equal(r?.booking.confidence, 'high');
  });

  test('the departure time survives its timezone', () => {
    // +11:00 on 14 March at 09:20 is 22:20 UTC on the 13th. Getting this wrong
    // moves a flight by a day, in the direction that makes someone miss it.
    assert.equal(parseBooking({ html: jsonLd(FLIGHT) })?.booking.itemDate, '2027-03-13T22:20:00.000Z');
  });

  test('the flight number and route land in the notes', () => {
    const notes = parseBooking({ html: jsonLd(FLIGHT) })?.booking.notes ?? '';
    assert.match(notes, /QF1/);
    assert.match(notes, /SYD to LHR/);
  });

  test('a hotel uses check-in, not the arrival of anything else', () => {
    const r = parseBooking({
      html: jsonLd({
        '@type': 'LodgingReservation',
        reservationNumber: 'HTL-771',
        checkinTime: '2027-03-15T14:00:00Z',
        checkoutTime: '2027-03-18T10:00:00Z',
        reservationFor: { '@type': 'LodgingBusiness', name: 'Hotel Sample' },
      }),
    });
    assert.equal(r?.booking.type, 'accommodation');
    assert.equal(r?.booking.provider, 'Hotel Sample');
    assert.match(String(r?.booking.itemDate), /^2027-03-15/);
    assert.match(String(r?.booking.notes), /Checkout 2027-03-18/);
  });

  test('a car hire uses pick-up and the rental company', () => {
    const r = parseBooking({
      html: jsonLd({
        '@type': 'RentalCarReservation',
        reservationNumber: 'CAR55',
        pickupTime: '2027-03-15T11:00:00Z',
        reservationFor: {
          '@type': 'RentalCar',
          rentalCompany: { '@type': 'Organization', name: 'Sample Rentals' },
        },
      }),
    });
    assert.equal(r?.booking.type, 'car_hire');
    assert.equal(r?.booking.provider, 'Sample Rentals');
  });

  test('the total paid is NOT reported as money owed', () => {
    // amountDue means outstanding. A paid holiday showing up as a bill is a
    // bug someone would act on.
    const r = parseBooking({
      html: jsonLd({ ...FLIGHT, totalPrice: '1450.00', priceCurrency: 'AUD' }),
    });
    assert.equal(r?.booking.amountDue, null);
  });

  test('markup that is not a reservation is ignored', () => {
    // A newsletter carrying Article or Organization markup must not become a
    // booking. This is the difference between "reads structured data" and
    // "believes anything in a script tag".
    const r = parseBooking({
      html: jsonLd({ '@type': 'Article', headline: 'Ten beaches you must see' }),
    });
    assert.equal(r, null);
  });

  test('a reservation inside an array or @graph is still found', () => {
    assert.equal(parseBooking({ html: jsonLd([{ '@type': 'WebPage' }, FLIGHT]) })?.method, 'json-ld');
    assert.equal(
      parseBooking({ html: jsonLd({ '@context': 'x', '@graph': [FLIGHT] }) })?.method,
      'json-ld'
    );
  });

  test('one malformed block does not lose a good one beside it', () => {
    const html =
      `<script type="application/ld+json">{ this is not json </script>` +
      `<script type="application/ld+json">${JSON.stringify(FLIGHT)}</script>`;
    assert.equal(parseBooking({ html })?.booking.confirmationNumber, 'ZZ9ABC');
  });
});

describe('calendar attachments', () => {
  const ics = [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'SUMMARY:Hotel Sample - booking confirmed',
    'DTSTART;TZID=Australia/Sydney:20270315T140000',
    'LOCATION:12 Example St\\, Sydney',
    'DESCRIPTION:Your confirmation number is HTL771. Check-in from 2pm.',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');

  test('the event is read', () => {
    const r = parseBooking({ ics });
    assert.equal(r?.method, 'ics');
    assert.equal(r?.booking.provider, 'Hotel Sample');
    assert.equal(r?.booking.confirmationNumber, 'HTL771');
    assert.match(String(r?.booking.itemDate), /^2027-03-15/);
  });

  test('a calendar result is still low confidence', () => {
    // The time is exact; the type and provider were read out of free text. It
    // would be easy and wrong to call the whole thing high.
    assert.equal(parseBooking({ ics })?.booking.confidence, 'low');
  });

  test('folded lines are rejoined before anything is read', () => {
    // iCalendar wraps long lines with a leading space, and a booking reference
    // is exactly the sort of value that gets split.
    const folded = [
      'BEGIN:VEVENT',
      'SUMMARY:Sample Air',
      'DESCRIPTION:Booking reference: ABC',
      ' 123',
      'DTSTART:20270314T092000Z',
      'END:VEVENT',
    ].join('\r\n');
    assert.equal(parseBooking({ ics: folded })?.booking.confirmationNumber, 'ABC123');
  });

  test('escaped commas are unescaped', () => {
    assert.match(String(parseBooking({ ics })?.booking.notes), /12 Example St, Sydney/);
  });

  test('a date-only DTSTART works', () => {
    const allDay = ['BEGIN:VEVENT', 'SUMMARY:Sample Tour', 'DTSTART;VALUE=DATE:20270316', 'END:VEVENT'].join('\r\n');
    assert.match(String(parseBooking({ ics: allDay })?.booking.itemDate), /^2027-03-16/);
  });

  test('markup wins over a calendar when both are present', () => {
    // Both describe the same booking; one of them is exact.
    const r = parseBooking({ html: jsonLd(FLIGHT), ics });
    assert.equal(r?.method, 'json-ld');
  });
});

describe('patterns — the last resort, and honest about it', () => {
  const plain = [
    'Thanks for booking with us.',
    '',
    'Booking reference: ZZ9ABC',
    'Flight QF1 departing 14 March 2027 at 09:20 from Sydney.',
    '',
    'See you on board.',
  ].join('\n');

  test('a plain-text confirmation still yields something usable', () => {
    const r = parseBooking({ text: plain, fromAddress: 'bookings@sampleair.com' });
    assert.equal(r?.method, 'patterns');
    assert.equal(r?.booking.confirmationNumber, 'ZZ9ABC');
    assert.equal(r?.booking.type, 'flight');
    assert.match(String(r?.booking.itemDate), /^2027-03-14/);
  });

  test('and is ALWAYS low confidence', () => {
    // Everything in this tier was inferred from wording. Nothing here may ever
    // claim otherwise.
    assert.equal(parseBooking({ text: plain })?.booking.confidence, 'low');
  });

  test('the provider comes from the sender when the text does not say', () => {
    const r = parseBooking({ text: plain, fromAddress: 'no-reply@sampleair.com' });
    assert.equal(r?.booking.provider, 'Sampleair');
  });

  test('a personal sender is not treated as a provider', () => {
    // Forwarded from someone's own inbox, which says nothing about who supplied
    // anything.
    const r = parseBooking({ text: plain, fromAddress: 'janette@gmail.com' });
    assert.equal(r?.booking.provider, null);
  });

  test('an ambiguous numeric date is refused, not guessed', () => {
    // 03/04/2027 is 3 April to most of the world and 4 March in the US, and
    // nothing in an email says which. A booking silently moved by a month is
    // worse than a blank field.
    const r = parseBooking({ text: 'Booking reference: ABC123\nDeparts 03/04/2027' });
    assert.equal(r?.booking.itemDate, null);
  });

  test('a reference is only taken when it is labelled as one', () => {
    // Six alphanumerics appear all over an email — coupon codes, tracking ids,
    // half a postcode. The label is what makes it a reference. The date is here
    // only so the parse survives and the reference can be inspected.
    const unlabelled = parseBooking({
      text: 'Use code SUMMER24 at checkout. Flight to Rome on 14 March 2027.',
    });
    assert.equal(unlabelled?.booking.confirmationNumber, null);

    assert.equal(
      parseBooking({ text: 'Record locator: XYZ987\nFlight to Rome' })?.booking.confirmationNumber,
      'XYZ987'
    );
  });

  test('the label word itself is not mistaken for the reference', () => {
    // "Booking reference: ZZ9ABC" once returned "REFERENCE", because the
    // pattern has to be case-insensitive to find the label and that made its
    // character classes case-insensitive too.
    assert.equal(
      parseBooking({ text: 'Booking reference: ZZ9ABC\nFlight to Rome' })?.booking.confirmationNumber,
      'ZZ9ABC'
    );
  });

  test('a long run of digits beside the label is not a locator', () => {
    // More likely an order total in cents, or a phone number.
    const r = parseBooking({
      text: 'Confirmation number: 1234567890\nYour flight departs 14 March 2027',
    });
    assert.equal(r?.booking.confirmationNumber, null);
    assert.match(String(r?.booking.itemDate), /^2027-03-14/);
  });

  test('money owed is picked up, money already paid is not', () => {
    const owed = parseBooking({ text: 'Booking reference: ABC123\nBalance due: 450.00' });
    assert.equal(owed?.booking.amountDue, 450);

    const paid = parseBooking({ text: 'Booking reference: ABC123\nTotal paid: 1,450.00' });
    assert.equal(paid?.booking.amountDue, null);
  });

  test('a marketing email produces nothing at all', () => {
    // No reference, no date, no named provider — nothing in the message says
    // it is a booking. An empty item somebody then has to find and delete is
    // worse than returning nothing.
    const r = parseBooking({ text: 'Summer sale! Save 30% on beach holidays. Unsubscribe here.' });
    assert.equal(r, null);
  });

  test('a marketing email FROM AN AIRLINE still produces nothing', () => {
    // Caught by a live run, not by the tests. The sender's domain used to count
    // as a provider, and a provider was enough to qualify the message — so
    // every promotional email an airline sends became a trip item. The domain
    // is now enrichment, applied only after the content has qualified.
    const r = parseBooking({
      text: 'Summer sale! Save 30% on beach holidays this year. Unsubscribe here.',
      subject: 'Our biggest sale of the year',
      fromAddress: 'bookings@example-airline.test',
    });
    assert.equal(r, null);
  });

  test('but a real booking from the same sender still gets the provider', () => {
    const r = parseBooking({
      text: 'Booking reference: ZZ9ABC\nDeparting 14 March 2027.',
      fromAddress: 'bookings@example-airline.test',
    });
    assert.equal(r?.booking.provider, 'Example-airline');
  });

  test('an empty message produces nothing', () => {
    assert.equal(parseBooking({}), null);
    assert.equal(parseBooking({ text: '   ' }), null);
  });

  test('types are told apart by their own vocabulary', () => {
    const cases: [string, string][] = [
      ['Your hire car pick-up location is Terminal 2. Reference: CAR001', 'car_hire'],
      ['Check-in from 3pm, check-out 10am. Reservation code: HOT001', 'accommodation'],
      ['Your airport transfer shuttle. Booking reference: TRF001', 'transfer'],
      ['Admission ticket for two. Booking reference: ACT001', 'activity'],
    ];
    for (const [text, expected] of cases) {
      assert.equal(parseBooking({ text })?.booking.type, expected, text);
    }
  });

  test('an HTML-only message is stripped and read', () => {
    const html = '<div><b>Booking reference:</b> ZZ9ABC<br>Your <i>flight</i> departs 14 March 2027</div>';
    const r = parseBooking({ html });
    assert.equal(r?.method, 'patterns');
    assert.equal(r?.booking.confirmationNumber, 'ZZ9ABC');
  });
});

describe('stripTags', () => {
  test('keeps the text and drops the markup', () => {
    assert.equal(stripTags('<p>Hello <b>there</b></p>'), 'Hello there');
  });

  test('drops script and style content entirely', () => {
    // Otherwise a tracking script becomes part of the text the patterns search.
    assert.equal(stripTags('<style>.a{color:red}</style><p>Hi</p>'), 'Hi');
    assert.equal(stripTags('<script>var code="ABC123"</script><p>Hi</p>'), 'Hi');
  });

  test('turns block ends into line breaks so labels do not run together', () => {
    assert.match(stripTags('<div>Reference: ABC</div><div>Flight QF1</div>'), /ABC\nFlight/);
  });

  test('decodes the entities that matter', () => {
    assert.equal(stripTags('<p>Ben &amp; Jerry&#39;s</p>'), "Ben & Jerry's");
  });
});
