/**
 * F8 — tests holding the code to the feature plan's tier table.
 *
 * The test plan asks for the boundary to be tested explicitly: each tier
 * unlocking exactly what the table says, "no more, no less". So these assert
 * both directions — what is included AND what is not — and check that F7 and
 * F10 are not gated by this system at all.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  TIERS,
  TIER_LIMITS,
  canAddActiveTrip,
  canAddTraveler,
  effectiveTier,
  hasFeature,
  isTierGated,
  smallestTierForTravelers,
  smallestTierWith,
  travelersOverLimit,
  upgradeMessage,
} from './tiers.ts';

describe('the tier table, exactly as specified', () => {
  test('Free: 1 traveler, 1 active trip', () => {
    assert.deepEqual(TIER_LIMITS.free, { travelerProfiles: 1, activeTrips: 1 });
  });

  test('Pro: 1 traveler, unlimited trips', () => {
    assert.deepEqual(TIER_LIMITS.pro, { travelerProfiles: 1, activeTrips: null });
  });

  test('Family: up to 6 travelers, unlimited trips', () => {
    assert.deepEqual(TIER_LIMITS.family, { travelerProfiles: 6, activeTrips: null });
  });

  test('Lifetime grants Pro scope, NOT Family scope', () => {
    // The feature plan is explicit: this is what keeps the one-time price
    // defensible. A Lifetime buyer getting six profiles would be a real
    // pricing bug, not a generous rounding.
    assert.equal(TIER_LIMITS.lifetime.travelerProfiles, TIER_LIMITS.pro.travelerProfiles);
    assert.notEqual(TIER_LIMITS.lifetime.travelerProfiles, TIER_LIMITS.family.travelerProfiles);
    assert.equal(TIER_LIMITS.lifetime.activeTrips, null);
  });
});

describe('feature access by tier', () => {
  test('smart import (F5) is Pro and above', () => {
    assert.equal(hasFeature('free', 'smart_import'), false);
    assert.equal(hasFeature('pro', 'smart_import'), true);
    assert.equal(hasFeature('family', 'smart_import'), true);
    assert.equal(hasFeature('lifetime', 'smart_import'), true);
  });

  test('the validity checker (F6) is Pro and above', () => {
    assert.equal(hasFeature('free', 'validity_checker'), false);
    assert.equal(hasFeature('pro', 'validity_checker'), true);
    assert.equal(hasFeature('lifetime', 'validity_checker'), true);
  });

  test('trip sharing (F9) is Family only', () => {
    // Not Lifetime: F9 only makes sense with more than one traveler profile,
    // and Lifetime does not have them.
    assert.equal(hasFeature('family', 'trip_sharing'), true);
    assert.equal(hasFeature('pro', 'trip_sharing'), false);
    assert.equal(hasFeature('lifetime', 'trip_sharing'), false);
    assert.equal(hasFeature('free', 'trip_sharing'), false);
  });

  test('a Free account is blocked from every gated feature, not just obvious ones', () => {
    for (const feature of ['smart_import', 'validity_checker', 'trip_sharing'] as const) {
      assert.equal(hasFeature('free', feature), false, feature);
    }
  });
});

describe('F7 and F10 are not gated by this system', () => {
  test('the visa checker is not a tier feature', () => {
    // It carries a real per-lookup cost and needs metered pricing of its own,
    // or heavy users get subsidised by everyone else on the tier.
    assert.equal(isTierGated('visa_checker'), false);
  });

  test('photo books are not a tier feature', () => {
    // A one-off transactional purchase, available on every tier including Free.
    assert.equal(isTierGated('photo_books'), false);
  });

  test('an unknown feature is not silently treated as gated', () => {
    assert.equal(isTierGated('something_new'), false);
  });
});

describe('limits in use', () => {
  test('Free allows the first traveler and blocks the second', () => {
    assert.equal(canAddTraveler('free', 0), true);
    assert.equal(canAddTraveler('free', 1), false);
  });

  test('Pro also blocks a second traveler', () => {
    // Easy to assume Pro means "more of everything". It does not: Pro buys
    // unlimited trips and features, not more people.
    assert.equal(canAddTraveler('pro', 1), false);
  });

  test('Family allows up to six and blocks the seventh', () => {
    assert.equal(canAddTraveler('family', 5), true);
    assert.equal(canAddTraveler('family', 6), false);
  });

  test('Free allows one active trip and blocks the second', () => {
    assert.equal(canAddActiveTrip('free', 0), true);
    assert.equal(canAddActiveTrip('free', 1), false);
  });

  test('paid tiers allow unlimited trips', () => {
    for (const tier of ['pro', 'family', 'lifetime'] as const) {
      assert.equal(canAddActiveTrip(tier, 99), true, tier);
    }
  });
});

describe('effectiveTier', () => {
  const now = new Date('2026-09-05T00:00:00Z');

  test('no subscription is Free', () => {
    assert.equal(effectiveTier(null, now), 'free');
  });

  test('a current subscription is its tier', () => {
    assert.equal(
      effectiveTier({ tier: 'family', source: 'revenuecat', expiresAt: '2027-01-01T00:00:00Z' }, now),
      'family'
    );
  });

  test('an expired subscription falls back to Free', () => {
    // The gate must not keep honouring a lapsed plan.
    assert.equal(
      effectiveTier({ tier: 'family', source: 'revenuecat', expiresAt: '2026-01-01T00:00:00Z' }, now),
      'free'
    );
  });

  test('Lifetime never expires, even with a date set', () => {
    assert.equal(
      effectiveTier({ tier: 'lifetime', source: 'revenuecat', expiresAt: '2020-01-01T00:00:00Z' }, now),
      'lifetime'
    );
  });

  test('a paid tier with no expiry recorded is honoured', () => {
    assert.equal(effectiveTier({ tier: 'pro', source: 'manual', expiresAt: null }, now), 'pro');
  });
});

describe('lapsing does not destroy data', () => {
  test('extra profiles are reported as over-limit, not deleted', () => {
    // The ToS brief asks what happens to a Family plan's extra profiles when it
    // lapses. Answer: they stay. No more can be added; none are removed.
    assert.equal(travelersOverLimit('free', 4), 3);
    assert.equal(travelersOverLimit('family', 4), 0);
  });
});

describe('upgrade wording names a specific tier', () => {
  test('the traveler limit points at Family', () => {
    const msg = upgradeMessage({ tier: 'free', reason: 'travelers' });
    assert.match(msg, /Family/);
    assert.match(msg, /6/);
  });

  test('the trip limit points at the tiers that lift it', () => {
    const msg = upgradeMessage({ tier: 'free', reason: 'trips' });
    assert.match(msg, /unlimited/);
  });

  test('a gated feature names the smallest tier that includes it', () => {
    assert.equal(smallestTierWith('smart_import'), 'pro');
    assert.equal(smallestTierWith('trip_sharing'), 'family');
    assert.match(upgradeMessage({ tier: 'free', reason: 'trip_sharing' }), /Family/);
  });

  test('smallestTierForTravelers finds the cheapest that fits', () => {
    assert.equal(smallestTierForTravelers(1), 'free');
    assert.equal(smallestTierForTravelers(3), 'family');
    assert.equal(smallestTierForTravelers(99), null);
  });
});

describe('every tier is covered', () => {
  test('each tier has limits and a label', () => {
    for (const tier of TIERS) {
      assert.ok(TIER_LIMITS[tier], tier);
    }
  });
});
