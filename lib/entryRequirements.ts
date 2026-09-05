/**
 * F6 — passport validity checker, seam only. Not built until Phase 8.
 *
 * F3's "Check entry requirements" button is a soft integration point, not a
 * hard dependency: it must degrade to a plain "not available yet" message,
 * never error and never disappear. CLAUDE.md calls this out as a critical
 * constraint.
 *
 * Availability is a real runtime probe rather than a hardcoded flag: it asks
 * whether F6's `entry_requirements` table exists. That means the fallback path
 * is genuinely exercised today, and the button starts working the moment
 * Phase 8's migration lands — no code change here, and no flag anyone can
 * forget to flip.
 */
import { supabase } from './supabase';

/** PostgREST's code for "no such table in the schema cache". */
const TABLE_MISSING = 'PGRST205';

let cached: boolean | null = null;

/**
 * Whether F6 exists yet. Cached for the session — the answer only changes when
 * a migration is applied, which does not happen mid-session.
 */
export async function isEntryRequirementCheckAvailable(): Promise<boolean> {
  if (cached !== null) return cached;

  const { error } = await supabase.from('entry_requirements').select('country').limit(1);

  if (error && (error.code === TABLE_MISSING || /schema cache/i.test(error.message))) {
    cached = false;
  } else if (error) {
    // Some other failure — a network blip, say. Treat as unavailable for now
    // but do not cache, so a later attempt can succeed.
    return false;
  } else {
    cached = true;
  }
  return cached;
}

/** Only for tests and for a manual re-probe after applying a migration. */
export function resetEntryRequirementCache(): void {
  cached = null;
}

export const ENTRY_REQUIREMENTS_UNAVAILABLE_MESSAGE =
  "Entry requirement checking isn't available yet — check back soon.";

export type EntryRequirementResult = {
  country: string;
  minPassportValidityMonths: number;
  verified: boolean;
  lastVerified: string | null;
  notes: string | null;
};

/**
 * Phase 8 implements this against the seeded reference table. Until then it is
 * unreachable: callers must check availability first, and F3 does.
 */
export async function lookupEntryRequirement(
  country: string
): Promise<EntryRequirementResult | null> {
  if (!(await isEntryRequirementCheckAvailable())) {
    throw new Error(ENTRY_REQUIREMENTS_UNAVAILABLE_MESSAGE);
  }

  const { data, error } = await supabase
    .from('entry_requirements')
    .select('country, min_passport_validity_months, verified, last_verified, notes')
    .eq('country', country.toUpperCase())
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) return null;

  return {
    country: data.country,
    minPassportValidityMonths: data.min_passport_validity_months,
    verified: data.verified,
    lastVerified: data.last_verified,
    notes: data.notes,
  };
}
