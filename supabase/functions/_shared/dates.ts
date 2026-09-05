/**
 * Date arithmetic shared by the app and the Edge Functions.
 *
 * Lives under supabase/functions/_shared because that is the one place both
 * runtimes can reach: Deno bundles it when a function imports it, and Metro
 * resolves it for the app. Web-standard APIs only, so `node --test` can load it
 * too.
 *
 * F3's passport rule and F2's reminder milestones both hinge on this, and a
 * second copy of month-clamping is exactly where a subtle bug would hide.
 */

/**
 * Add whole months to an ISO date, clamping to the end of the target month.
 * Negative values subtract.
 *
 * The clamp has to be explicit: 31 August plus six months is not 3 March, but
 * that is what JavaScript's Date gives you, because it rolls the overflow into
 * the next month.
 */
export function addMonths(isoDate: string, months: number): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  if (!y || !m || !d) throw new Error(`Not an ISO date: ${isoDate}`);

  const targetMonthIndex = m - 1 + months;
  const targetYear = y + Math.floor(targetMonthIndex / 12);
  const targetMonth = ((targetMonthIndex % 12) + 12) % 12;

  // Day 0 of the following month is the last day of the target month.
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const day = Math.min(d, lastDay);

  return `${String(targetYear).padStart(4, '0')}-${String(targetMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Today as an ISO date in UTC. Injectable so tests are deterministic. */
export function todayIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Whole days from `from` to `to`; negative when `to` is in the past. */
export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) throw new Error('Not an ISO date');
  return Math.round((b - a) / 86_400_000);
}
