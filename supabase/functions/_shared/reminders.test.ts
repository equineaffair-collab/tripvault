/**
 * F2 — tests for the reminder engine.
 *
 * These cover the decisions the daily sweep makes. The test plan's F2 section
 * asks specifically that each milestone fires the right channel combination and
 * that email cannot be switched off; both are asserted here rather than left to
 * a manual run against a seeded expiry date.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  MILESTONES,
  canUserDisable,
  channelsForMilestone,
  effectiveChannels,
  planReminder,
  planSweep,
  reminderText,
  triggerDate,
} from './reminders.ts';

describe('channel escalation', () => {
  test('six months out is email only', () => {
    assert.deepEqual(channelsForMilestone(6), ['email']);
  });

  test('three months out adds push', () => {
    assert.deepEqual(channelsForMilestone(3), ['email', 'push']);
  });

  test('one month out adds a persistent in-app banner', () => {
    assert.deepEqual(channelsForMilestone(1), ['email', 'push', 'banner']);
  });

  test('every milestone includes email', () => {
    // The escalation is additive: later milestones add channels, never swap
    // one out. Email is the durable channel and must be in all three.
    for (const m of MILESTONES) {
      assert.ok(channelsForMilestone(m).includes('email'), `milestone ${m}`);
    }
  });
});

describe('email cannot be switched off', () => {
  test('push and banner are user-controllable, email is not', () => {
    assert.equal(canUserDisable('email'), false);
    assert.equal(canUserDisable('push'), true);
    assert.equal(canUserDisable('banner'), true);
  });

  test('disabling push still leaves email at every milestone', () => {
    // F2's deliberate decision: silencing both would mean the app's core
    // promise quietly stops holding, with no signal that it has.
    for (const m of MILESTONES) {
      const channels = effectiveChannels(m, { pushEnabled: false });
      assert.ok(channels.includes('email'), `milestone ${m} lost email`);
      assert.ok(!channels.includes('push'), `milestone ${m} kept push`);
    }
  });

  test('enabling push restores it where the milestone calls for it', () => {
    assert.deepEqual(effectiveChannels(3, { pushEnabled: true }), ['email', 'push']);
    assert.deepEqual(effectiveChannels(6, { pushEnabled: true }), ['email']);
  });
});

describe('triggerDate', () => {
  test('counts back whole months from expiry', () => {
    assert.equal(triggerDate('2027-06-15', 6), '2026-12-15');
    assert.equal(triggerDate('2027-06-15', 1), '2027-05-15');
  });

  test('clamps when counting back into a shorter month', () => {
    assert.equal(triggerDate('2027-03-31', 1), '2027-02-28');
  });
});

describe('planReminder', () => {
  const expiry = '2027-06-15';

  test('nothing is owed long before the first milestone', () => {
    const plan = planReminder({ expiryDate: expiry, today: '2026-01-01', handled: [] });
    assert.equal(plan.send, null);
  });

  test('the six-month milestone fires on its trigger date', () => {
    const plan = planReminder({ expiryDate: expiry, today: '2026-12-15', handled: [] });
    assert.equal(plan.send, 6);
    assert.deepEqual(plan.supersede, []);
  });

  test('the day before the trigger, nothing is owed', () => {
    const plan = planReminder({ expiryDate: expiry, today: '2026-12-14', handled: [] });
    assert.equal(plan.send, null);
  });

  test('once six is handled, three fires at its own time', () => {
    const plan = planReminder({ expiryDate: expiry, today: '2027-03-15', handled: [6] });
    assert.equal(plan.send, 3);
  });

  test('a document added late sends only the most urgent milestone', () => {
    // The case that matters: adding a passport that already expires next month
    // must not produce three emails in one sweep.
    const plan = planReminder({ expiryDate: expiry, today: '2027-05-20', handled: [] });
    assert.equal(plan.send, 1);
    assert.deepEqual(plan.supersede.sort(), [3, 6]);
  });

  test('superseded milestones do not fire on later days', () => {
    const plan = planReminder({ expiryDate: expiry, today: '2027-05-25', handled: [1, 3, 6] });
    assert.equal(plan.send, null);
  });

  test('an already-expired document still reminds once', () => {
    const plan = planReminder({ expiryDate: '2026-01-01', today: '2026-09-05', handled: [] });
    assert.equal(plan.send, 1);
    assert.equal(plan.expired, true);
  });

  test('an expired document that was already reminded stays quiet', () => {
    const plan = planReminder({ expiryDate: '2026-01-01', today: '2026-09-05', handled: [1, 3, 6] });
    assert.equal(plan.send, null);
    assert.equal(plan.expired, true);
  });

  test('a document with no expiry is never owed anything', () => {
    const plan = planReminder({ expiryDate: null, today: '2026-09-05', handled: [] });
    assert.equal(plan.send, null);
    assert.equal(plan.expired, false);
  });

  test('expired is false on the expiry date itself', () => {
    const plan = planReminder({ expiryDate: '2026-09-05', today: '2026-09-05', handled: [1, 3, 6] });
    assert.equal(plan.expired, false);
  });
});

describe('planSweep', () => {
  const doc = (id: string, travelerId: string, expiry: string | null) => ({
    id,
    traveler_id: travelerId,
    type: 'passport',
    expiry_date: expiry,
    country: 'AUS',
  });

  test('plans across many documents, skipping those owed nothing', () => {
    const planned = planSweep({
      documents: [
        doc('d1', 't1', '2027-06-15'), // six months out on this date
        doc('d2', 't2', '2030-01-01'), // far away
        doc('d3', 't3', null), // no expiry
      ],
      handledByDocument: {},
      today: '2026-12-15',
    });
    assert.equal(planned.length, 1);
    assert.equal(planned[0].documentId, 'd1');
    assert.equal(planned[0].milestone, 6);
  });

  test('applies per-traveler push preferences', () => {
    const planned = planSweep({
      documents: [doc('d1', 't1', '2027-06-15')],
      handledByDocument: {},
      today: '2027-03-15',
      prefsByTraveler: { t1: { pushEnabled: false } },
    });
    assert.deepEqual(planned[0].channels, ['email']);
  });

  test('defaults to push enabled when no preference is recorded', () => {
    const planned = planSweep({
      documents: [doc('d1', 't1', '2027-06-15')],
      handledByDocument: {},
      today: '2027-03-15',
    });
    assert.deepEqual(planned[0].channels, ['email', 'push']);
  });

  test('respects what has already been handled', () => {
    const planned = planSweep({
      documents: [doc('d1', 't1', '2027-06-15')],
      handledByDocument: { d1: [6] },
      today: '2026-12-20',
    });
    assert.equal(planned.length, 0);
  });
});

describe('reminderText', () => {
  test('names the person and the document', () => {
    const { subject, body } = reminderText({
      travelerName: 'Sam',
      documentType: 'passport',
      expiryDate: '2027-06-15',
      milestone: 3,
      expired: false,
    });
    assert.match(subject, /Sam's passport expires in about 3 months/);
    assert.match(body, /2027-06-15/);
  });

  test('the one-month wording is different and more urgent', () => {
    const { subject, body } = reminderText({
      travelerName: 'Sam',
      documentType: 'passport',
      expiryDate: '2027-06-15',
      milestone: 1,
      expired: false,
    });
    assert.match(subject, /in under a month/);
    assert.match(body, /several weeks/);
  });

  test('an expired document says so in the past tense', () => {
    const { subject, body } = reminderText({
      travelerName: 'Sam',
      documentType: 'passport',
      expiryDate: '2026-01-01',
      milestone: 1,
      expired: true,
    });
    assert.match(subject, /has expired/);
    assert.match(body, /expired on 2026-01-01/);
  });

  test('handles a non-passport document type readably', () => {
    const { subject } = reminderText({
      travelerName: 'Sam',
      documentType: 'id_card',
      expiryDate: '2027-06-15',
      milestone: 6,
      expired: false,
    });
    assert.match(subject, /id card/);
  });
});
