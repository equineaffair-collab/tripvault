/**
 * F4 — tests for the pure display helpers.
 *
 * The CRUD itself is exercised against the live project by
 * scripts/verify-f4.mjs, which is where the RLS and constraint behaviour that
 * actually matters can be checked.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  groupByType,
  maskMembershipNumber,
  type LoyaltyProgram,
  type LoyaltyType,
} from './loyaltyFormat.ts';

const program = (id: string, type: LoyaltyType, provider: string): LoyaltyProgram => ({
  id,
  traveler_id: 't1',
  type,
  provider_name: provider,
  membership_number: `NO-${id}`,
  tier_status: null,
  notes: null,
  created_at: '2026-01-01T00:00:00Z',
});

describe('groupByType', () => {
  test('groups in the declared type order, not insertion order', () => {
    const groups = groupByType([
      program('1', 'hotel', 'Hilton'),
      program('2', 'airline', 'Qantas'),
      program('3', 'rail', 'Eurostar'),
    ]);
    assert.deepEqual(
      groups.map((g) => g.type),
      ['airline', 'hotel', 'rail']
    );
  });

  test('keeps several programs of the same type together', () => {
    // F4 explicitly supports more than one per type -- two airline schemes is
    // ordinary, and a one-per-type assumption would be a bug.
    const groups = groupByType([
      program('1', 'airline', 'Qantas'),
      program('2', 'airline', 'Singapore Airlines'),
    ]);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].programs.length, 2);
  });

  test('skips types with nothing in them', () => {
    const groups = groupByType([program('1', 'other', 'Something')]);
    assert.deepEqual(
      groups.map((g) => g.type),
      ['other']
    );
  });

  test('returns nothing for an empty list', () => {
    assert.deepEqual(groupByType([]), []);
  });

  test('carries a human label for each group', () => {
    const groups = groupByType([program('1', 'car_rental', 'Hertz')]);
    assert.equal(groups[0].label, 'Car hire');
  });
});

describe('maskMembershipNumber', () => {
  test('shows only the last four characters', () => {
    assert.equal(maskMembershipNumber('QF1234567890'), '••••7890');
  });

  test('returns a short number whole rather than masking it to nothing', () => {
    assert.equal(maskMembershipNumber('1234'), '1234');
    assert.equal(maskMembershipNumber('99'), '99');
  });

  test('trims before measuring', () => {
    assert.equal(maskMembershipNumber('  1234  '), '1234');
    assert.equal(maskMembershipNumber('  QF1234567890  '), '••••7890');
  });

  test('handles an empty string', () => {
    assert.equal(maskMembershipNumber(''), '');
    assert.equal(maskMembershipNumber('   '), '');
  });
});
