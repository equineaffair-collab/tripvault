/**
 * F8 — what each tier unlocks.
 *
 * The feature plan puts this in one place deliberately, so gating decisions are
 * not inferred from scattered notes on individual features. This module is that
 * one place, and it is pure so `node --test` can hold it to the table.
 *
 * Two features are deliberately absent, and their absence is the point:
 *   F7  (visa checker)  — a real per-lookup cost, so it needs metered pricing
 *                          of its own rather than being subsidised by a tier.
 *   F10 (photo books)   — a one-off transactional purchase, available on every
 *                          tier including Free.
 * `isTierGated()` below returns false for both, and the tests check it.
 */

export const TIERS = ['free', 'pro', 'family', 'lifetime'] as const;
export type Tier = (typeof TIERS)[number];

export const TIER_LABELS: Record<Tier, string> = {
  free: 'Free',
  pro: 'Pro',
  family: 'Family',
  lifetime: 'Lifetime',
};

/** Illustrative, per the feature plan. Real prices come from the stores. */
export const TIER_PRICING: Record<Tier, string> = {
  free: 'Free',
  pro: '$4.99/month or $29.99/year',
  family: '$49.99/year',
  lifetime: 'One-time purchase',
};

export type TierLimits = {
  /** Maximum traveler profiles. */
  travelerProfiles: number;
  /** Maximum simultaneously active trips; null means unlimited. */
  activeTrips: number | null;
};

export const TIER_LIMITS: Record<Tier, TierLimits> = {
  free: { travelerProfiles: 1, activeTrips: 1 },
  pro: { travelerProfiles: 1, activeTrips: null },
  // The whole point of Family: multiple travelers is what makes F3's
  // multi-attendee checklist and F1/F4's per-traveler data meaningful.
  family: { travelerProfiles: 6, activeTrips: null },
  // Lifetime buys Pro's feature set, NOT Family's multi-traveler scope. The
  // feature plan is explicit that this is what keeps the one-time price
  // defensible.
  lifetime: { travelerProfiles: 1, activeTrips: null },
};

/** Features whose availability depends on tier. */
export const GATED_FEATURES = ['smart_import', 'validity_checker', 'trip_sharing'] as const;
export type GatedFeature = (typeof GATED_FEATURES)[number];

export const FEATURE_LABELS: Record<GatedFeature, string> = {
  smart_import: 'Smart import (F5)',
  validity_checker: 'Passport validity checker (F6)',
  trip_sharing: 'Family member access (F9)',
};

const FEATURE_TIERS: Record<GatedFeature, readonly Tier[]> = {
  smart_import: ['pro', 'family', 'lifetime'],
  validity_checker: ['pro', 'family', 'lifetime'],
  // F9 only makes sense once there is more than one traveler profile to link.
  trip_sharing: ['family'],
};

export function hasFeature(tier: Tier, feature: GatedFeature): boolean {
  return FEATURE_TIERS[feature].includes(tier);
}

/**
 * Whether a feature is gated by the subscription at all.
 *
 * F7 and F10 are not, by design. Asking this rather than assuming everything is
 * tiered is what stops them being quietly folded in later.
 */
export function isTierGated(feature: string): feature is GatedFeature {
  return (GATED_FEATURES as readonly string[]).includes(feature);
}

export function limitsFor(tier: Tier): TierLimits {
  return TIER_LIMITS[tier];
}

/** Whether another traveler profile can be added at this tier. */
export function canAddTraveler(tier: Tier, currentCount: number): boolean {
  return currentCount < TIER_LIMITS[tier].travelerProfiles;
}

/** Whether another active trip can be created at this tier. */
export function canAddActiveTrip(tier: Tier, currentActiveCount: number): boolean {
  const limit = TIER_LIMITS[tier].activeTrips;
  return limit === null || currentActiveCount < limit;
}

/**
 * The smallest tier that would allow something, for an upgrade prompt that
 * names a specific tier rather than saying "upgrade" and leaving the user to
 * work out which one.
 */
export function smallestTierWith(feature: GatedFeature): Tier {
  return TIERS.find((t) => hasFeature(t, feature)) as Tier;
}

export function smallestTierForTravelers(count: number): Tier | null {
  return TIERS.find((t) => TIER_LIMITS[t].travelerProfiles >= count) ?? null;
}

/** Wording for a blocked action. Names the tier, and says why it exists. */
export function upgradeMessage(args: {
  tier: Tier;
  reason: 'travelers' | 'trips' | GatedFeature;
}): string {
  if (args.reason === 'travelers') {
    const limit = TIER_LIMITS[args.tier].travelerProfiles;
    return (
      `Your ${TIER_LABELS[args.tier]} plan covers ${limit} traveler profile${limit === 1 ? '' : 's'}. ` +
      `Family covers up to ${TIER_LIMITS.family.travelerProfiles}, which is what makes trips for a whole household work.`
    );
  }
  if (args.reason === 'trips') {
    const limit = TIER_LIMITS[args.tier].activeTrips;
    return (
      `Your ${TIER_LABELS[args.tier]} plan covers ${limit} active trip${limit === 1 ? '' : 's'} at a time. ` +
      `Pro, Family and Lifetime all cover unlimited trips.`
    );
  }
  const needed = smallestTierWith(args.reason);
  return `${FEATURE_LABELS[args.reason]} is part of ${TIER_LABELS[needed]}.`;
}

export type Subscription = {
  tier: Tier;
  source: 'none' | 'revenuecat' | 'manual';
  expiresAt: string | null;
};

/**
 * The tier actually in force.
 *
 * An expired subscription is Free, not the tier it used to be. Lifetime never
 * expires — "for as long as TripVault operates as a service" is a business
 * commitment, not a date on a row — so it has no expiry to check.
 */
export function effectiveTier(sub: Subscription | null, now: Date = new Date()): Tier {
  if (!sub) return 'free';
  if (sub.tier === 'lifetime' || sub.tier === 'free') return sub.tier;
  if (!sub.expiresAt) return sub.tier;
  return Date.parse(sub.expiresAt) > now.getTime() ? sub.tier : 'free';
}

/**
 * What happens to data when a plan lapses.
 *
 * The ToS brief asks this be stated: extra traveler profiles are NOT deleted
 * when Family lapses to Free. They become read-only-ish — over the limit, so no
 * more can be added — but destroying someone's records because a card expired
 * would be indefensible.
 */
export function travelersOverLimit(tier: Tier, currentCount: number): number {
  return Math.max(0, currentCount - TIER_LIMITS[tier].travelerProfiles);
}
