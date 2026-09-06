/**
 * F9 — tests for the two mechanisms' shared arithmetic and wording.
 *
 * The parts worth pinning are the ones where being wrong is silent: a link
 * reported as active after it expired, a share described as itinerary-only when
 * it carries documents, and the refusal reasons drifting away from the database
 * guards they are supposed to mirror.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  LINKED_ACCESS_DENIALS,
  LINKED_ACCESS_GRANTS,
  SHARE_DOCUMENTS_WARNING,
  SHARE_LINK_NOTE,
  describeInvite,
  describeShareLink,
  inviteBlockReason,
  inviteStatus,
  shareBlockReason,
  shareLinkStatus,
  shareUrl,
  type Invite,
  type ShareLink,
} from './familyAccessFormat.ts';
import { TIERS } from './tiers.ts';

const NOW = new Date('2026-09-06T00:00:00Z');

const invite = (over: Partial<Invite> = {}): Invite => ({
  id: 'i1',
  travelerId: 't1',
  createdAt: '2026-09-01T00:00:00Z',
  expiresAt: '2026-09-20T00:00:00Z',
  acceptedAt: null,
  ...over,
});

const share = (over: Partial<ShareLink> = {}): ShareLink => ({
  id: 's1',
  tripId: 'trip1',
  label: null,
  includesDocuments: false,
  revoked: false,
  createdAt: '2026-09-01T00:00:00Z',
  expiresAt: null,
  ...over,
});

describe('invite status', () => {
  test('live until its expiry', () => {
    assert.equal(inviteStatus(invite(), NOW), 'pending');
  });

  test('expired once the moment passes', () => {
    assert.equal(inviteStatus(invite({ expiresAt: '2026-09-05T23:59:00Z' }), NOW), 'expired');
  });

  test('accepted beats expired — a used invite is not "expired"', () => {
    // Both are true of this row. Reporting it as expired would suggest nothing
    // happened, when in fact someone now has a login.
    const used = invite({ expiresAt: '2026-08-01T00:00:00Z', acceptedAt: '2026-07-20T00:00:00Z' });
    assert.equal(inviteStatus(used, NOW), 'accepted');
  });

  test('the countdown is in whole days and says "today" on the last one', () => {
    assert.match(describeInvite(invite({ expiresAt: '2026-09-20T00:00:00Z' }), NOW), /14 days/);
    assert.match(describeInvite(invite({ expiresAt: '2026-09-06T10:00:00Z' }), NOW), /today/);
  });
});

describe('why an invite is refused', () => {
  test('every tier below Family is told which tier this is', () => {
    for (const tier of TIERS) {
      const reason = inviteBlockReason({
        tier,
        traveler: { name: 'Sam', isMinor: false, linkedAuthUserId: null },
      });
      if (tier === 'family') assert.equal(reason, null);
      else assert.match(String(reason), /Family/);
    }
  });

  test('a child profile is refused, and the reason says what happens instead', () => {
    const reason = inviteBlockReason({
      tier: 'family',
      traveler: { name: 'Ada', isMinor: true, linkedAuthUserId: null },
    });
    assert.match(String(reason), /child/i);
    // Not a dead end: the organizer keeps managing that profile themselves.
    assert.match(String(reason), /your own account/i);
  });

  test("your own profile is refused, because you already see everything", () => {
    // Not a database rule: 'self' is a label the account holder picked. But
    // offering it is nonsense, and the invite would only be redeemable by
    // somebody else.
    const reason = inviteBlockReason({
      tier: 'family',
      traveler: { name: 'Janette', isMinor: false, linkedAuthUserId: null, relationship: 'self' },
    });
    assert.match(String(reason), /your own profile/i);
  });

  test('any other relationship is fine', () => {
    for (const relationship of ['partner', 'child', 'other', undefined]) {
      const reason = inviteBlockReason({
        tier: 'family',
        traveler: { name: 'Sam', isMinor: false, linkedAuthUserId: null, relationship },
      });
      assert.equal(reason, null, String(relationship));
    }
  });

  test('an already-linked profile is refused', () => {
    const reason = inviteBlockReason({
      tier: 'family',
      traveler: { name: 'Sam', isMinor: false, linkedAuthUserId: 'u2' },
    });
    assert.match(String(reason), /already has their own login/);
  });

  test('the tier gate is checked before anything else', () => {
    // A Free user looking at a child profile should be told about the tier,
    // not about the child rule — the tier is the thing they can act on, and
    // ordering here matches the order the database checks them in.
    const reason = inviteBlockReason({
      tier: 'free',
      traveler: { name: 'Ada', isMinor: true, linkedAuthUserId: 'u2' },
    });
    assert.match(String(reason), /Family/);
  });
});

describe('share link status', () => {
  test('no expiry date means it stays active', () => {
    assert.equal(shareLinkStatus(share(), NOW), 'active');
  });

  test('expired once the date passes', () => {
    assert.equal(shareLinkStatus(share({ expiresAt: '2026-09-01T00:00:00Z' }), NOW), 'expired');
  });

  test('revoked beats expired', () => {
    // "Revoked" is what the organizer did; "expired" is what time did. If both
    // are true, the deliberate act is the one worth reporting back to them.
    const dead = share({ revoked: true, expiresAt: '2026-09-01T00:00:00Z' });
    assert.equal(shareLinkStatus(dead, NOW), 'revoked');
  });

  test('the description names the scope, because that is the risky part', () => {
    assert.match(describeShareLink(share({ includesDocuments: true }), NOW), /documents/);
    assert.match(describeShareLink(share({ includesDocuments: false }), NOW), /checklist only/);
  });

  test('a link with no expiry says so rather than staying silent', () => {
    assert.match(describeShareLink(share(), NOW), /no expiry date/);
  });

  test('the label is used so a list of links can be told apart', () => {
    assert.match(describeShareLink(share({ label: 'Mum' }), NOW), /Shared with Mum/);
  });
});

describe('the share URL', () => {
  test('points at the function that renders the page', () => {
    assert.equal(
      shareUrl('https://abc.supabase.co', 'tok'),
      'https://abc.supabase.co/functions/v1/shared-trip?t=tok'
    );
  });

  test('a trailing slash on the project URL does not double up', () => {
    assert.equal(
      shareUrl('https://abc.supabase.co/', 'tok'),
      'https://abc.supabase.co/functions/v1/shared-trip?t=tok'
    );
  });

  test('the token is escaped', () => {
    assert.match(shareUrl('https://abc.supabase.co', 'a b'), /a%20b$/);
  });
});

describe('what the organizer is told', () => {
  test('sharing is refused below Family, allowed at Family', () => {
    assert.equal(shareBlockReason('family'), null);
    for (const tier of TIERS.filter((t) => t !== 'family')) {
      assert.match(String(shareBlockReason(tier)), /Family/);
    }
  });

  test('the access summary states both halves', () => {
    // A list of what someone gains, with no list of what they do not, reads as
    // reassurance rather than information.
    assert.ok(LINKED_ACCESS_GRANTS.length > 0);
    assert.ok(LINKED_ACCESS_DENIALS.length > 0);
    assert.match(LINKED_ACCESS_DENIALS.join(' '), /read-only/);
    assert.match(LINKED_ACCESS_DENIALS.join(' '), /documents/);
  });

  test('the document warning says the recipient needs no account', () => {
    // The single most surprising property of a share link, and the one that
    // makes it different from every other kind of access in the app.
    assert.match(SHARE_DOCUMENTS_WARNING, /do not need an account/);
    assert.match(SHARE_DOCUMENTS_WARNING, /revoke/);
  });

  test('no wording promises document numbers are shared', () => {
    // The function never decrypts one, at any setting. Copy that implied it
    // might would be a promise the code deliberately does not keep.
    assert.match(SHARE_LINK_NOTE, /never shows document numbers/);
  });
});
