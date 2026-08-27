import { supabase } from './supabase';
import type { Relationship, Traveler } from '../types/traveler';

const TABLE = 'travelers';

/**
 * F8 tier limits (1 profile on Free/Pro, 6 on Family) are specified as being
 * enforced here, but F8 does not exist until Phase 6 — and Phase 1's own test
 * asks for two profiles, which a Free limit would block. So this is the seam,
 * not the enforcement: Phase 6 fills it in and calls it from createTraveler.
 */
export const TIER_PROFILE_LIMITS = { free: 1, pro: 1, family: 6, lifetime: 1 } as const;

export async function listTravelers(): Promise<Traveler[]> {
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .order('created_at', { ascending: true });

  if (error) throw new Error(error.message);
  return (data ?? []) as Traveler[];
}

export async function createTraveler(input: {
  name: string;
  relationship: Relationship;
}): Promise<Traveler> {
  const { data: auth, error: authError } = await supabase.auth.getUser();
  if (authError || !auth.user) throw new Error('You need to be logged in.');

  // is_minor is intentionally not sent — the database trigger derives it.
  const { data, error } = await supabase
    .from(TABLE)
    .insert({
      user_id: auth.user.id,
      name: input.name.trim(),
      relationship: input.relationship,
    })
    .select()
    .single();

  if (error) throw new Error(error.message);
  return data as Traveler;
}

export async function updateTraveler(
  id: string,
  changes: { name?: string; relationship?: Relationship }
): Promise<Traveler> {
  const patch: Record<string, unknown> = {};
  if (changes.name !== undefined) patch.name = changes.name.trim();
  if (changes.relationship !== undefined) patch.relationship = changes.relationship;

  const { data, error } = await supabase
    .from(TABLE)
    .update(patch)
    .eq('id', id)
    .select()
    .single();

  if (error) throw new Error(error.message);
  return data as Traveler;
}

export async function deleteTraveler(id: string): Promise<void> {
  const { error } = await supabase.from(TABLE).delete().eq('id', id);
  if (error) throw new Error(error.message);
}
