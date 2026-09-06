/** F11 — traveler profile management. */

export const RELATIONSHIPS = ['self', 'partner', 'child', 'other'] as const;
export type Relationship = (typeof RELATIONSHIPS)[number];

export const RELATIONSHIP_LABELS: Record<Relationship, string> = {
  self: 'Myself',
  partner: 'Partner',
  child: 'Child',
  other: 'Other',
};

export type Traveler = {
  id: string;
  user_id: string;
  name: string;
  relationship: Relationship;
  /** Server-derived from relationship; never written by the client. */
  is_minor: boolean;
  /** F9 — set when this profile has its own linked login (Phase 10). */
  linked_auth_user_id: string | null;
  created_at: string;
};

/**
 * Which relationships mark a profile as a minor. The database trigger in
 * 0001_travelers.sql is the authority; this mirrors it so the UI can warn
 * before saving. Keep the two in step.
 */
export function impliesMinor(relationship: Relationship): boolean {
  return relationship === 'child';
}
