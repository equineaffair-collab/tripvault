/**
 * F4 — types and pure display helpers for loyalty programs.
 *
 * Split from lib/loyalty.ts so these can be unit tested: that module imports
 * the Supabase client, which pulls in React Native and cannot load under
 * `node --test`. Anything here must stay free of runtime imports.
 */

export const LOYALTY_TYPES = ['airline', 'hotel', 'car_rental', 'rail', 'other'] as const;
export type LoyaltyType = (typeof LOYALTY_TYPES)[number];

export const LOYALTY_TYPE_LABELS: Record<LoyaltyType, string> = {
  airline: 'Airline',
  hotel: 'Hotel',
  car_rental: 'Car hire',
  rail: 'Rail',
  other: 'Other',
};

export type LoyaltyProgram = {
  id: string;
  traveler_id: string;
  type: LoyaltyType;
  provider_name: string;
  membership_number: string;
  tier_status: string | null;
  notes: string | null;
  created_at: string;
};

export type LoyaltyInput = {
  type: LoyaltyType;
  providerName: string;
  membershipNumber: string;
  tierStatus?: string | null;
  notes?: string | null;
};

/** Group programs by type, in the declared order, skipping empty groups. */
export function groupByType(
  programs: readonly LoyaltyProgram[]
): { type: LoyaltyType; label: string; programs: LoyaltyProgram[] }[] {
  const out: { type: LoyaltyType; label: string; programs: LoyaltyProgram[] }[] = [];
  for (const type of LOYALTY_TYPES) {
    const matching = programs.filter((p) => p.type === type);
    if (matching.length > 0) {
      out.push({ type, label: LOYALTY_TYPE_LABELS[type], programs: matching });
    }
  }
  return out;
}

/**
 * Mask a membership number for list display, showing only the last four
 * characters.
 *
 * This is not a security control — the value is readable by anyone holding the
 * account, and F4 deliberately does not encrypt it. It is a shoulder-surfing
 * courtesy that also stops a long number dominating a row. Short numbers are
 * returned whole rather than masked to nothing.
 */
export function maskMembershipNumber(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 4) return trimmed;
  return `••••${trimmed.slice(-4)}`;
}
