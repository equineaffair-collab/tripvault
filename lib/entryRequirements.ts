/**
 * F6 — passport validity checker.
 *
 * Answers "is this passport valid enough for this destination" and nothing
 * else. Visa determination is F7's, exclusively; see the feature plan's F6/F7
 * design note for why the two are kept apart, and lib/entryRequirementsFormat
 * for the comparison itself.
 *
 * F3's "Check entry requirements" button is a soft integration point, not a
 * hard dependency. Availability is a runtime probe rather than a flag: it asks
 * whether this feature's table exists. That kept the fallback genuinely live
 * before Phase 8, and now flips it on with no code change on F3's side.
 */
import { supabase } from './supabase';
import { checkPassports, type EntryRequirement, type ValidityCheck } from './entryRequirementsFormat';

export {
  checkPassports,
  disclaimerFor,
  requiredValidUntil,
} from './entryRequirementsFormat';
export type {
  EntryRequirement,
  PassportForCheck,
  PassportVerdict,
  ValidityCheck,
} from './entryRequirementsFormat';

/** PostgREST's code for "no such table in the schema cache". */
const TABLE_MISSING = 'PGRST205';

let cached: boolean | null = null;

export async function isEntryRequirementCheckAvailable(): Promise<boolean> {
  if (cached !== null) return cached;

  const { error } = await supabase.from('entry_requirements').select('country').limit(1);

  if (error && (error.code === TABLE_MISSING || /schema cache/i.test(error.message))) {
    cached = false;
  } else if (error) {
    // Some other failure — a network blip, say. Unavailable for now, but not
    // cached, so a later attempt can succeed.
    return false;
  } else {
    cached = true;
  }
  return cached;
}

export function resetEntryRequirementCache(): void {
  cached = null;
}

export const ENTRY_REQUIREMENTS_UNAVAILABLE_MESSAGE =
  "Entry requirement checking isn't available yet — check back soon.";

export const ENTRY_REQUIREMENT_UNKNOWN_MESSAGE =
  "That destination isn't in TripVault's reference list yet, so its passport rule can't be checked here. Check with the relevant embassy or consulate.";

function toRequirement(row: Record<string, unknown>): EntryRequirement {
  return {
    country: row.country as string,
    countryName: row.country_name as string,
    minPassportValidityMonths: row.min_passport_validity_months as number,
    countedFrom: row.counted_from as 'entry' | 'exit',
    verified: row.verified as boolean,
    lastVerified: (row.last_verified as string | null) ?? null,
    notes: (row.notes as string | null) ?? null,
  };
}

/** Look up one destination's rule. Null when it is not in the reference list. */
export async function lookupEntryRequirement(
  country: string
): Promise<EntryRequirement | null> {
  if (!(await isEntryRequirementCheckAvailable())) {
    throw new Error(ENTRY_REQUIREMENTS_UNAVAILABLE_MESSAGE);
  }

  const term = country.trim();
  if (!term) return null;

  const COLUMNS =
    'country, country_name, min_passport_validity_months, counted_from, verified, last_verified, notes';

  // An ICAO code first, since it is unambiguous.
  const { data: byCode, error } = await supabase
    .from('entry_requirements')
    .select(COLUMNS)
    .eq('country', term.toUpperCase())
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (byCode) return toRequirement(byCode as Record<string, unknown>);

  // Then by name. The destination field is free text labelled "Destination" --
  // people type "Thailand", not "THA", and refusing to match that would make
  // the whole check look broken for the most obvious input.
  const { data: byName, error: nameError } = await supabase
    .from('entry_requirements')
    .select(COLUMNS)
    .ilike('country_name', term)
    .maybeSingle();

  if (nameError) throw new Error(nameError.message);
  return byName ? toRequirement(byName as Record<string, unknown>) : null;
}

/** Every destination the reference list covers, for a picker. */
export async function listKnownDestinations(): Promise<
  { country: string; countryName: string; verified: boolean }[]
> {
  const { data, error } = await supabase
    .from('entry_requirements')
    .select('country, country_name, verified')
    .order('country_name', { ascending: true });

  if (error) throw new Error(error.message);
  return (data ?? []).map((r: Record<string, unknown>) => ({
    country: r.country as string,
    countryName: r.country_name as string,
    verified: r.verified as boolean,
  }));
}

export type TravelerValidityResult = {
  travelerId: string;
  travelerName: string;
  check: ValidityCheck | null;
  /** Set when the traveler holds no passport at all. */
  problem: string | null;
};

/**
 * The whole check for one trip: look up the destination's rule, then compare
 * every passport each attendee holds.
 *
 * Takes a country and dates rather than a trip record, so it can be exercised
 * standalone — F6 is explicit that it must not need a real trip to exist.
 */
export async function runEntryRequirementCheck(args: {
  destinationCountry: string;
  attendees: readonly { id: string; name: string }[];
  startDate: string | null;
  endDate: string | null;
}): Promise<{ requirement: EntryRequirement | null; results: TravelerValidityResult[] }> {
  const requirement = await lookupEntryRequirement(args.destinationCountry);
  if (!requirement) return { requirement: null, results: [] };

  if (args.attendees.length === 0) return { requirement, results: [] };

  const { data, error } = await supabase
    .from('documents')
    .select('id, traveler_id, type, country, expiry_date, is_primary')
    .in('traveler_id', args.attendees.map((a) => a.id))
    .eq('type', 'passport');

  if (error) throw new Error(error.message);

  const rows = (data ?? []) as Array<{
    id: string;
    traveler_id: string;
    country: string | null;
    expiry_date: string | null;
    is_primary: boolean;
  }>;

  const results: TravelerValidityResult[] = args.attendees.map((attendee) => {
    const passports = rows
      .filter((r) => r.traveler_id === attendee.id)
      .map((r) => ({
        id: r.id,
        country: r.country,
        expiryDate: r.expiry_date,
        isPrimary: r.is_primary,
      }));

    if (passports.length === 0) {
      return {
        travelerId: attendee.id,
        travelerName: attendee.name,
        check: null,
        problem: `${attendee.name} has no passport saved, so there's nothing to check.`,
      };
    }

    return {
      travelerId: attendee.id,
      travelerName: attendee.name,
      check: checkPassports({
        requirement,
        passports,
        trip: { startDate: args.startDate, endDate: args.endDate },
      }),
      problem: null,
    };
  });

  return { requirement, results };
}
