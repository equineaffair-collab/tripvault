/**
 * F4 — loyalty program storage.
 *
 * Storage only. F4 explicitly does not fetch or display point balances, so
 * there is deliberately no code here that reaches an airline or hotel API, and
 * none should be added without revisiting the feature plan.
 *
 * Types and pure display helpers live in ./loyaltyFormat so they can be unit
 * tested without loading the Supabase client.
 */
import { supabase } from './supabase';
import type { LoyaltyInput, LoyaltyProgram } from './loyaltyFormat';

export {
  LOYALTY_TYPES,
  LOYALTY_TYPE_LABELS,
  groupByType,
  maskMembershipNumber,
} from './loyaltyFormat';
export type { LoyaltyType, LoyaltyProgram, LoyaltyInput } from './loyaltyFormat';

const COLUMNS =
  'id, traveler_id, type, provider_name, membership_number, tier_status, notes, created_at';

/** Postgres unique_violation, raised by loyalty_programs_no_exact_duplicates. */
const DUPLICATE = '23505';

export class DuplicateLoyaltyProgram extends Error {
  constructor() {
    super('That membership number is already saved for this provider.');
    this.name = 'DuplicateLoyaltyProgram';
  }
}

function translate(error: { code?: string; message: string }): Error {
  if (error.code === DUPLICATE) return new DuplicateLoyaltyProgram();
  return new Error(error.message);
}

export async function listLoyaltyPrograms(travelerId: string): Promise<LoyaltyProgram[]> {
  const { data, error } = await supabase
    .from('loyalty_programs')
    .select(COLUMNS)
    .eq('traveler_id', travelerId)
    .order('type', { ascending: true })
    .order('provider_name', { ascending: true });

  if (error) throw translate(error);
  return (data ?? []) as LoyaltyProgram[];
}

/** Every program across the account — used by F12's export. */
export async function listAllLoyaltyPrograms(): Promise<LoyaltyProgram[]> {
  const { data, error } = await supabase.from('loyalty_programs').select(COLUMNS);
  if (error) throw translate(error);
  return (data ?? []) as LoyaltyProgram[];
}

function toRow(input: LoyaltyInput) {
  return {
    type: input.type,
    provider_name: input.providerName.trim(),
    membership_number: input.membershipNumber.trim(),
    tier_status: input.tierStatus?.trim() || null,
    notes: input.notes?.trim() || null,
  };
}

export async function createLoyaltyProgram(
  travelerId: string,
  input: LoyaltyInput
): Promise<LoyaltyProgram> {
  const { data, error } = await supabase
    .from('loyalty_programs')
    .insert({ traveler_id: travelerId, ...toRow(input) })
    .select(COLUMNS)
    .single();

  if (error) throw translate(error);
  return data as LoyaltyProgram;
}

export async function updateLoyaltyProgram(
  id: string,
  input: LoyaltyInput
): Promise<LoyaltyProgram> {
  const { data, error } = await supabase
    .from('loyalty_programs')
    .update(toRow(input))
    .eq('id', id)
    .select(COLUMNS)
    .single();

  if (error) throw translate(error);
  return data as LoyaltyProgram;
}

export async function deleteLoyaltyProgram(id: string): Promise<void> {
  const { error } = await supabase.from('loyalty_programs').delete().eq('id', id);
  if (error) throw translate(error);
}
