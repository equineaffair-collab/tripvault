/**
 * F6 — passport validity comparison.
 *
 * Answers one question and only one: does this passport have enough remaining
 * validity for this destination. Whether a visa is needed is F7's job and is
 * not decided, hinted at, or guessed anywhere in this file. The feature plan's
 * F6/F7 design note explains why that separation is deliberate, and the test
 * plan checks it holds.
 *
 * Pure, so `node --test` can load it.
 */
import { addMonths } from '../supabase/functions/_shared/dates.ts';

export type EntryRequirement = {
  country: string;
  countryName: string;
  minPassportValidityMonths: number;
  /** Whether the months are counted from arrival or from departure. */
  countedFrom: 'entry' | 'exit';
  verified: boolean;
  lastVerified: string | null;
  notes: string | null;
};

export type PassportForCheck = {
  id: string;
  country: string | null;
  expiryDate: string | null;
  isPrimary: boolean;
};

export type PassportVerdict = {
  passportId: string;
  passportCountry: string | null;
  expiryDate: string | null;
  /** The date this passport must remain valid until for this destination. */
  requiredUntil: string | null;
  clears: boolean;
  reason: 'ok' | 'no-expiry-recorded' | 'expires-too-soon' | 'expires-before-travel';
};

export type ValidityCheck = {
  requirement: EntryRequirement;
  verdicts: PassportVerdict[];
  /** The passport to travel on, or null when none clears. */
  recommended: PassportVerdict | null;
  /** Why that one, in words, for the UI to show rather than invent. */
  recommendationReason: string;
  anyClears: boolean;
};

/**
 * The date a passport must stay valid until.
 *
 * `entry` rules count from arrival, `exit` rules from departure. The difference
 * is the length of the trip, which is not a rounding error on a long stay: six
 * months from arrival on a three-month trip is three months past the return.
 */
export function requiredValidUntil(
  requirement: EntryRequirement,
  trip: { startDate: string | null; endDate: string | null }
): string | null {
  const anchor = requirement.countedFrom === 'entry' ? trip.startDate : trip.endDate;
  if (!anchor) return null;
  return addMonths(anchor, requirement.minPassportValidityMonths);
}

/**
 * Check every passport a traveler holds, not just the primary one.
 *
 * F6 is explicit about this: a dual national may hold one passport that clears
 * and one that does not, and the useful answer is which to travel on.
 */
export function checkPassports(args: {
  requirement: EntryRequirement;
  passports: readonly PassportForCheck[];
  trip: { startDate: string | null; endDate: string | null };
}): ValidityCheck {
  const { requirement, passports, trip } = args;
  const requiredUntil = requiredValidUntil(requirement, trip);
  const travelEnd = trip.endDate ?? trip.startDate;

  const verdicts: PassportVerdict[] = passports.map((p) => {
    if (!p.expiryDate) {
      return {
        passportId: p.id,
        passportCountry: p.country,
        expiryDate: null,
        requiredUntil,
        clears: false,
        reason: 'no-expiry-recorded',
      };
    }
    if (travelEnd && p.expiryDate < travelEnd) {
      return {
        passportId: p.id,
        passportCountry: p.country,
        expiryDate: p.expiryDate,
        requiredUntil,
        clears: false,
        reason: 'expires-before-travel',
      };
    }
    if (requiredUntil && p.expiryDate < requiredUntil) {
      return {
        passportId: p.id,
        passportCountry: p.country,
        expiryDate: p.expiryDate,
        requiredUntil,
        clears: false,
        reason: 'expires-too-soon',
      };
    }
    return {
      passportId: p.id,
      passportCountry: p.country,
      expiryDate: p.expiryDate,
      requiredUntil,
      clears: true,
      reason: 'ok',
    };
  });

  const clearing = verdicts.filter((v) => v.clears);

  // Among passports that clear, prefer the one that lasts longest — it is the
  // one least likely to need renewing before the trip after this one. Ties go
  // to the traveler's own primary, since that is the one they think of as
  // theirs.
  const recommended =
    clearing.length === 0
      ? null
      : clearing.reduce((best, v) => {
          if ((v.expiryDate ?? '') > (best.expiryDate ?? '')) return v;
          if ((v.expiryDate ?? '') < (best.expiryDate ?? '')) return best;
          const vIsPrimary = passports.find((p) => p.id === v.passportId)?.isPrimary ?? false;
          return vIsPrimary ? v : best;
        });

  return {
    requirement,
    verdicts,
    recommended,
    recommendationReason: describeRecommendation(requirement, verdicts, recommended),
    anyClears: clearing.length > 0,
  };
}

function describeRecommendation(
  requirement: EntryRequirement,
  verdicts: readonly PassportVerdict[],
  recommended: PassportVerdict | null
): string {
  const rule =
    requirement.minPassportValidityMonths === 0
      ? `${requirement.countryName} is commonly published as requiring a passport valid for the duration of your stay`
      : `${requirement.countryName} is commonly published as requiring ${requirement.minPassportValidityMonths} month${
          requirement.minPassportValidityMonths === 1 ? '' : 's'
        } of validity beyond your ${requirement.countedFrom === 'entry' ? 'arrival' : 'departure'}`;

  if (!recommended) {
    return `${rule}. None of the passports on file meets that.`;
  }

  const country = recommended.passportCountry ?? 'this';
  if (verdicts.length === 1) {
    return `${rule}. The ${country} passport meets that.`;
  }

  const clearing = verdicts.filter((v) => v.clears).length;
  if (clearing === verdicts.length) {
    return `${rule}. Both passports meet that; the ${country} one has the longest remaining validity.`;
  }
  return `${rule}. Travel on the ${country} passport — it's the one that meets it.`;
}

/**
 * The disclaimer that must accompany every result.
 *
 * F6 is advisory only, and the ToS brief treats that as a liability point, not a
 * politeness. The wording changes when the underlying row is unverified, because
 * presenting unconfirmed reference data as though it were confirmed is exactly
 * the failure the `verified` flag exists to prevent.
 */
export function disclaimerFor(requirement: EntryRequirement): string {
  const base =
    'This is advisory only and can change. Always confirm with the relevant embassy or consulate before travelling.';

  if (!requirement.verified) {
    return (
      "This rule hasn't been verified against an authoritative source yet, so treat it as a " +
      `prompt to check rather than an answer. ${base}`
    );
  }
  return `Last verified ${requirement.lastVerified}. ${base}`;
}
