/**
 * F8 — reading the account's tier, and asking what it unlocks.
 *
 * The tier is read-only from here by design: `subscriptions` has no INSERT or
 * UPDATE policy for authenticated users. Writes come from the service role,
 * which is what a RevenueCat webhook presents. An app that could set its own
 * tier would make every check in this file decorative.
 *
 * RevenueCat is not wired up yet. `entitlementProvider` below is the seam it
 * will fill; until then the tier comes from the database, which supports a
 * 'manual' source for support grants and for testing.
 */
import { supabase } from './supabase';
import {
  canAddActiveTrip,
  canAddTraveler,
  effectiveTier,
  hasFeature,
  limitsFor,
  type GatedFeature,
  type Subscription,
  type Tier,
} from './tiers';

export {
  TIERS,
  TIER_LABELS,
  TIER_LIMITS,
  TIER_PRICING,
  FEATURE_LABELS,
  GATED_FEATURES,
  canAddActiveTrip,
  canAddTraveler,
  effectiveTier,
  hasFeature,
  isTierGated,
  limitsFor,
  smallestTierWith,
  travelersOverLimit,
  upgradeMessage,
} from './tiers';
export type { Tier, GatedFeature, TierLimits, Subscription } from './tiers';

/**
 * Where entitlement comes from.
 *
 * RevenueCat will implement this: on launch it identifies the user, reads their
 * entitlements, and a webhook writes the result to `subscriptions`. Everything
 * else in the app reads the database, so swapping the provider in changes only
 * this seam — nothing that consumes a tier needs to know where it came from.
 */
export type EntitlementProvider = {
  name: string;
  /** Refresh entitlement from the store. No-op until RevenueCat is wired up. */
  refresh: () => Promise<void>;
  /** Whether purchases can actually be made yet. */
  canPurchase: boolean;
};

export const stubEntitlementProvider: EntitlementProvider = {
  name: 'none',
  refresh: async () => {
    // RevenueCat's SDK call goes here. Deliberately does nothing rather than
    // pretending: the tier in the database is the truth either way, so an app
    // running against this stub behaves correctly, just without a way to buy.
  },
  canPurchase: false,
};

let provider: EntitlementProvider = stubEntitlementProvider;

export function setEntitlementProvider(next: EntitlementProvider): void {
  provider = next;
}

export function currentEntitlementProvider(): EntitlementProvider {
  return provider;
}

export async function getSubscription(): Promise<Subscription | null> {
  const { data, error } = await supabase
    .from('subscriptions')
    .select('tier, source, expires_at')
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) return null;

  return {
    tier: data.tier as Tier,
    source: data.source as Subscription['source'],
    expiresAt: (data.expires_at as string | null) ?? null,
  };
}

/** The tier in force. Free when there is no subscription, or it has lapsed. */
export async function getCurrentTier(): Promise<Tier> {
  try {
    return effectiveTier(await getSubscription());
  } catch {
    // A tier that cannot be read must not accidentally unlock anything.
    return 'free';
  }
}

export type AccountUsage = {
  tier: Tier;
  travelers: number;
  activeTrips: number;
  canAddTraveler: boolean;
  canAddTrip: boolean;
};

/**
 * Tier plus current counts, for a settings screen that can say "1 of 1 used"
 * rather than only telling someone they have hit a limit at the moment they do.
 */
export async function getAccountUsage(): Promise<AccountUsage> {
  const tier = await getCurrentTier();

  const [{ count: travelerCount }, { data: trips }] = await Promise.all([
    supabase.from('travelers').select('id', { count: 'exact', head: true }),
    supabase.from('trips').select('end_date'),
  ]);

  const today = new Date().toISOString().slice(0, 10);
  const activeTrips = (trips ?? []).filter(
    (t: { end_date: string | null }) => !t.end_date || t.end_date >= today
  ).length;

  const travelers = travelerCount ?? 0;

  return {
    tier,
    travelers,
    activeTrips,
    canAddTraveler: canAddTraveler(tier, travelers),
    canAddTrip: canAddActiveTrip(tier, activeTrips),
  };
}

/**
 * Whether a gated feature is available. The UI uses this to explain rather than
 * to protect — the database triggers and the absent write policies do the
 * protecting, and the test plan checks the difference.
 */
export async function featureAvailable(feature: GatedFeature): Promise<boolean> {
  return hasFeature(await getCurrentTier(), feature);
}

export async function tierLimits() {
  return limitsFor(await getCurrentTier());
}
