/**
 * F12 — data export and account deletion, client side.
 *
 * Both go through the `account` Edge Function: export needs the encryption key
 * to include document numbers in the clear, and deletion needs the service role
 * to remove the auth user itself. Neither is possible from the app.
 */
import { supabase } from './supabase';

export class ReauthenticationRequired extends Error {
  constructor() {
    super('Please log in again before exporting your data.');
    this.name = 'ReauthenticationRequired';
  }
}

export type ExportPackage = {
  format: string;
  generated_at: string;
  account: { id: string; email: string | null };
  travelers: unknown[];
  documents: unknown[];
  trips: unknown[];
  trip_items: unknown[];
  trip_checklist_items: unknown[];
  loyalty_programs: unknown[];
};

async function call<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke('account', { body });

  if (error) {
    const response = (error as { context?: Response }).context;
    if (response && typeof response.json === 'function') {
      const payload = await response.json().catch(() => null);
      if (payload?.code === 'REAUTH_REQUIRED') throw new ReauthenticationRequired();
      if (payload?.error) throw new Error(payload.error);
    }
    throw new Error(error.message);
  }
  return data as T;
}

/**
 * Everything the account holds, in one readable package.
 *
 * Requires a session authenticated within the last few minutes. The caller
 * should catch ReauthenticationRequired, sign the user in again, and retry —
 * that produces a fresh token, which is what the server checks.
 */
export async function exportAccountData(): Promise<ExportPackage> {
  const { export: pkg } = await call<{ export: ExportPackage }>({ action: 'export' });
  return pkg;
}

/**
 * Permanently delete the account and everything in it.
 *
 * Distinct from cancelling a subscription (F8), which F12 is explicit about:
 * the interface must not imply one does the other.
 */
export async function deleteAccount(): Promise<void> {
  await call<{ deleted: boolean }>({ action: 'delete', confirmation: 'DELETE' });
}

/** A short human summary of what an export contains, for the confirmation screen. */
export function describeExport(pkg: ExportPackage): string {
  const parts = [
    [pkg.travelers.length, 'traveler profile'],
    [pkg.documents.length, 'document'],
    [pkg.trips.length, 'trip'],
    [pkg.trip_items.length, 'booking'],
    [pkg.loyalty_programs.length, 'loyalty program'],
  ] as const;

  return parts
    .filter(([n]) => n > 0)
    .map(([n, noun]) => `${n} ${noun}${n === 1 ? '' : 's'}`)
    .join(', ');
}
