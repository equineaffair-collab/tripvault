/**
 * F3 — tests for the trip logic that carries real consequence: the six-month
 * passport rule, and the checklist ordering the feature plan is specific about.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  addMonths,
  checkPassportValidity,
  checklistLabelForIssue,
  checklistProgress,
  groupChecklist,
  shouldGroupChecklist,
  sortChecklist,
  type ChecklistItem,
  type PassportLike,
} from './tripsFormat.ts';

const passport = (
  id: string,
  travelerId: string,
  expiry: string | null,
  country = 'AUS'
): PassportLike => ({
  id,
  traveler_id: travelerId,
  type: 'passport',
  expiry_date: expiry,
  country,
});

const item = (
  id: string,
  over: Partial<ChecklistItem> = {}
): ChecklistItem => ({
  id,
  trip_id: 'trip1',
  label: `Item ${id}`,
  category: 'planning',
  status: 'todo',
  source: 'manual',
  linked_trip_item_id: null,
  created_at: `2026-01-0${id}T00:00:00Z`,
  ...over,
});

describe('addMonths', () => {
  test('adds whole months', () => {
    assert.equal(addMonths('2026-03-15', 6), '2026-09-15');
  });

  test('rolls over a year boundary', () => {
    assert.equal(addMonths('2026-10-10', 6), '2027-04-10');
  });

  test('clamps to the end of a shorter month', () => {
    // The case naive arithmetic gets wrong: 31 August plus six months is not
    // 3 March. Date would roll the overflow forward.
    assert.equal(addMonths('2025-08-31', 6), '2026-02-28');
  });

  test('clamps to 29 February in a leap year', () => {
    assert.equal(addMonths('2027-08-31', 6), '2028-02-29');
  });

  test('handles 31 January plus one month', () => {
    assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  });

  test('rejects a malformed date', () => {
    assert.throws(() => addMonths('not-a-date', 6));
  });
});

describe('checkPassportValidity', () => {
  const attendees = [{ id: 'p1', name: 'Janette' }];

  test('a passport with well over six months clears', () => {
    const issues = checkPassportValidity({
      attendees,
      documents: [passport('d1', 'p1', '2030-01-01')],
      tripEndDate: '2026-10-10',
    });
    assert.deepEqual(issues, []);
  });

  test('flags a passport that expires inside the six-month window', () => {
    const issues = checkPassportValidity({
      attendees,
      documents: [passport('d1', 'p1', '2027-01-01')],
      tripEndDate: '2026-10-10',
    });
    assert.equal(issues.length, 1);
    assert.equal(issues[0].kind, 'insufficient-validity');
    assert.equal(issues[0].requiredUntil, '2027-04-10');
  });

  test('distinguishes a passport that expires before the trip even ends', () => {
    // Materially worse than falling short of the six-month buffer, and the
    // wording needs to differ.
    const issues = checkPassportValidity({
      attendees,
      documents: [passport('d1', 'p1', '2026-09-01')],
      tripEndDate: '2026-10-10',
    });
    assert.equal(issues[0].kind, 'expired-before-trip');
    assert.match(issues[0].message, /before the trip ends/);
  });

  test('exactly on the boundary passes', () => {
    const issues = checkPassportValidity({
      attendees,
      documents: [passport('d1', 'p1', '2027-04-10')],
      tripEndDate: '2026-10-10',
    });
    assert.deepEqual(issues, []);
  });

  test('one day short of the boundary fails', () => {
    const issues = checkPassportValidity({
      attendees,
      documents: [passport('d1', 'p1', '2027-04-09')],
      tripEndDate: '2026-10-10',
    });
    assert.equal(issues.length, 1);
  });

  test('a dual national passes if ANY passport clears', () => {
    // F6 later recommends which to travel on. F3 must not nag about the one
    // they were never going to use.
    const issues = checkPassportValidity({
      attendees,
      documents: [passport('d1', 'p1', '2026-11-01', 'AUS'), passport('d2', 'p1', '2031-01-01', 'LVA')],
      tripEndDate: '2026-10-10',
    });
    assert.deepEqual(issues, []);
  });

  test('a dual national with two bad passports is reported once, on the better one', () => {
    const issues = checkPassportValidity({
      attendees,
      documents: [passport('d1', 'p1', '2026-11-01'), passport('d2', 'p1', '2026-12-01')],
      tripEndDate: '2026-10-10',
    });
    assert.equal(issues.length, 1);
    assert.equal(issues[0].documentId, 'd2');
  });

  test('reports a traveler with no passport at all', () => {
    const issues = checkPassportValidity({
      attendees,
      documents: [],
      tripEndDate: '2026-10-10',
    });
    assert.equal(issues[0].kind, 'no-passport');
    assert.equal(issues[0].documentId, null);
  });

  test('reports a passport with no expiry rather than silently passing it', () => {
    const issues = checkPassportValidity({
      attendees,
      documents: [passport('d1', 'p1', null)],
      tripEndDate: '2026-10-10',
    });
    assert.equal(issues[0].kind, 'no-expiry-recorded');
  });

  test('ignores non-passport documents', () => {
    const visa = { ...passport('d1', 'p1', '2026-11-01'), type: 'visa' };
    const issues = checkPassportValidity({
      attendees,
      documents: [visa],
      tripEndDate: '2026-10-10',
    });
    assert.equal(issues[0].kind, 'no-passport');
  });

  test('checks every attendee, not just the first', () => {
    const issues = checkPassportValidity({
      attendees: [
        { id: 'p1', name: 'Janette' },
        { id: 'p2', name: 'Sam' },
      ],
      documents: [passport('d1', 'p1', '2030-01-01')],
      tripEndDate: '2026-10-10',
    });
    assert.equal(issues.length, 1);
    assert.equal(issues[0].travelerName, 'Sam');
  });

  test('returns nothing when the trip has no end date to check against', () => {
    assert.deepEqual(
      checkPassportValidity({ attendees, documents: [], tripEndDate: null }),
      []
    );
  });

  test('honours a non-default validity requirement', () => {
    // Some destinations ask for three months, not six.
    const issues = checkPassportValidity({
      attendees,
      documents: [passport('d1', 'p1', '2027-02-01')],
      tripEndDate: '2026-10-10',
      monthsRequired: 3,
    });
    assert.deepEqual(issues, []);
  });
});

describe('checklistLabelForIssue', () => {
  test('names the person and the action for each kind', () => {
    const base = {
      travelerId: 'p1',
      travelerName: 'Sam',
      documentId: null,
      expiryDate: null,
      requiredUntil: '2027-04-10',
      message: '',
    };
    assert.match(checklistLabelForIssue({ ...base, kind: 'no-passport' }), /Add Sam's passport/);
    assert.match(
      checklistLabelForIssue({ ...base, kind: 'insufficient-validity' }),
      /Renew Sam's passport/
    );
    assert.match(
      checklistLabelForIssue({ ...base, kind: 'expired-before-trip' }),
      /Renew Sam's passport/
    );
  });
});

describe('sortChecklist', () => {
  test('pins auto-generated items above routine tasks', () => {
    const sorted = sortChecklist([
      item('1', { source: 'manual', label: 'Book flights' }),
      item('2', { source: 'auto-passport', label: 'Renew passport' }),
    ]);
    assert.equal(sorted[0].label, 'Renew passport');
  });

  test('outstanding work sorts above completed work', () => {
    const sorted = sortChecklist([
      item('1', { status: 'done' }),
      item('2', { status: 'todo' }),
    ]);
    assert.equal(sorted[0].id, '2');
  });

  test('a done auto item still outranks a todo manual one', () => {
    // Urgency banding comes first: an auto item is deadline-driven whatever
    // its state, and moving it into the general pile once ticked would hide it.
    const sorted = sortChecklist([
      item('1', { source: 'manual', status: 'todo' }),
      item('2', { source: 'auto-passport', status: 'done' }),
    ]);
    assert.equal(sorted[0].id, '2');
  });

  test('orders by category within a band', () => {
    const sorted = sortChecklist([
      item('1', { category: 'planning' }),
      item('2', { category: 'documents' }),
      item('3', { category: 'bookings' }),
    ]);
    assert.deepEqual(
      sorted.map((i) => i.category),
      ['documents', 'bookings', 'planning']
    );
  });

  test('does not mutate the input', () => {
    const items = [item('1', { source: 'manual' }), item('2', { source: 'auto-passport' })];
    const before = items.map((i) => i.id);
    sortChecklist(items);
    assert.deepEqual(
      items.map((i) => i.id),
      before
    );
  });
});

describe('grouping and progress', () => {
  test('does not group a short list', () => {
    assert.equal(shouldGroupChecklist([item('1'), item('2')]), false);
  });

  test('groups once past the threshold', () => {
    const many = Array.from({ length: 9 }, (_, i) => item(String(i)));
    assert.equal(shouldGroupChecklist(many), true);
  });

  test('groupChecklist skips empty categories', () => {
    const groups = groupChecklist([item('1', { category: 'documents' })]);
    assert.deepEqual(
      groups.map((g) => g.category),
      ['documents']
    );
  });

  test('progress counts done against total', () => {
    const p = checklistProgress([
      item('1', { status: 'done' }),
      item('2', { status: 'done' }),
      item('3', { status: 'todo' }),
    ]);
    assert.equal(p.done, 2);
    assert.equal(p.total, 3);
    assert.equal(p.label, '2 of 3 done');
  });

  test('progress says something sensible for an empty list', () => {
    assert.equal(checklistProgress([]).label, 'Nothing on the list yet');
  });
});
