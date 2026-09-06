/**
 * F9 mechanism 1, organizer side — giving one traveler profile its own login.
 *
 * The screen's real job is not the button. It is answering "what am I about to
 * hand this person", before the code is generated rather than after, which is
 * why the two lists sit above the action and not behind a help link.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  LINKED_ACCESS_DENIALS,
  LINKED_ACCESS_GRANTS,
  cancelInvite,
  createInvite,
  describeInvite,
  inviteBlockReason,
  inviteStatus,
  listInvites,
  revokeLinkedAccess,
  type Invite,
} from '../lib/familyAccess';
import { getCurrentTier, type Tier } from '../lib/subscription';
import type { Traveler } from '../types/traveler';

type Props = {
  traveler: Traveler;
  onBack: () => void;
  /** Called after anything that changes the profile's linked state. */
  onChanged: () => void;
};

export default function FamilyAccessScreen({ traveler, onBack, onChanged }: Props) {
  const [tier, setTier] = useState<Tier>('free');
  const [invite, setInvite] = useState<Invite | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Held in memory only, and never written anywhere. The server keeps a hash;
  // if this is lost, the answer is a new code, not a lookup.
  const [code, setCode] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const [currentTier, invites] = await Promise.all([getCurrentTier(), listInvites()]);
      setTier(currentTier);
      setInvite(invites.find((i) => i.travelerId === traveler.id) ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load access details.');
    } finally {
      setLoading(false);
    }
  }, [traveler.id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const linked = Boolean(traveler.linked_auth_user_id);
  const blocked = inviteBlockReason({
    tier,
    traveler: {
      name: traveler.name,
      isMinor: traveler.is_minor,
      linkedAuthUserId: traveler.linked_auth_user_id,
    },
  });

  async function handleCreate() {
    setBusy(true);
    setError(null);
    try {
      const created = await createInvite(traveler.id);
      setCode(created.code);
      await refresh();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create an invite.');
    } finally {
      setBusy(false);
    }
  }

  function handleRevoke() {
    Alert.alert(
      `Remove ${traveler.name}'s access`,
      `${traveler.name} will stop seeing your trips straight away. Their own login still ` +
        `exists — this removes what they can see, not their account.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove access',
          style: 'destructive',
          onPress: async () => {
            setBusy(true);
            try {
              await revokeLinkedAccess(traveler.id);
              setCode(null);
              await refresh();
              onChanged();
            } catch (e) {
              Alert.alert('Could not remove access', e instanceof Error ? e.message : 'Unknown error');
            } finally {
              setBusy(false);
            }
          },
        },
      ]
    );
  }

  async function handleCancelInvite() {
    if (!invite) return;
    setBusy(true);
    try {
      await cancelInvite(invite.id);
      setCode(null);
      await refresh();
    } catch (e) {
      Alert.alert('Could not cancel', e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Pressable onPress={onBack} hitSlop={12}>
        <Text style={styles.back}>‹ Back</Text>
      </Pressable>

      <Text style={styles.title}>{traveler.name}'s own access</Text>
      <Text style={styles.lede}>
        Give {traveler.name} a login of their own, so the trips you add them to just appear on
        their phone — including their documents, offline, at an airport.
      </Text>

      {loading ? (
        <ActivityIndicator style={styles.spinner} />
      ) : (
        <>
          <View style={styles.card}>
            <Text style={styles.cardTitle}>They would be able to see</Text>
            {LINKED_ACCESS_GRANTS.map((line) => (
              <Text key={line} style={styles.bullet}>
                • {line}
              </Text>
            ))}
            <Text style={[styles.cardTitle, styles.cardTitleSpaced]}>They could not see</Text>
            {LINKED_ACCESS_DENIALS.map((line) => (
              <Text key={line} style={styles.bullet}>
                • {line}
              </Text>
            ))}
          </View>

          {error && <Text style={styles.error}>{error}</Text>}

          {linked ? (
            <View style={styles.statusBox}>
              <Text style={styles.statusText}>
                {traveler.name} has their own login and can see the trips they are on.
              </Text>
              <Pressable style={styles.dangerButton} onPress={handleRevoke} disabled={busy}>
                <Text style={styles.dangerButtonText}>Remove their access</Text>
              </Pressable>
            </View>
          ) : blocked ? (
            <View style={styles.blockedBox}>
              <Text style={styles.blockedText}>{blocked}</Text>
            </View>
          ) : code ? (
            <View style={styles.codeBox}>
              <Text style={styles.codeLabel}>Invite code — copy it now</Text>
              <Text selectable style={styles.code}>
                {code}
              </Text>
              <Text style={styles.codeNote}>
                Send this to {traveler.name} however you normally would. They sign up for
                TripVault, then enter this code on their Profile tab. This is the only time it
                is shown — if it gets lost, create a new one.
              </Text>
            </View>
          ) : invite && inviteStatus(invite) === 'pending' ? (
            <View style={styles.statusBox}>
              <Text style={styles.statusText}>{describeInvite(invite)}</Text>
              <Text style={styles.codeNote}>
                The code itself is not stored anywhere TripVault can read it back. If
                {' '}{traveler.name} no longer has it, cancel this invite and create a new one.
              </Text>
              <Pressable style={styles.secondaryButton} onPress={handleCancelInvite} disabled={busy}>
                <Text style={styles.secondaryButtonText}>Cancel this invite</Text>
              </Pressable>
            </View>
          ) : (
            <Pressable style={styles.primaryButton} onPress={handleCreate} disabled={busy}>
              <Text style={styles.primaryButtonText}>
                {busy ? 'Creating…' : `Give ${traveler.name} their own access`}
              </Text>
            </Pressable>
          )}

          {invite && inviteStatus(invite) === 'expired' && !linked && (
            <Text style={styles.hint}>{describeInvite(invite)}</Text>
          )}
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  content: { padding: 20, paddingBottom: 48 },
  back: { color: '#1B6EF3', fontSize: 16, marginBottom: 12 },
  title: { fontSize: 22, fontWeight: '700', marginBottom: 6 },
  lede: { fontSize: 15, color: '#444', lineHeight: 21, marginBottom: 18 },
  spinner: { marginTop: 24 },
  card: {
    backgroundColor: '#F5F7FA',
    borderRadius: 10,
    padding: 14,
    marginBottom: 18,
  },
  cardTitle: { fontSize: 13, fontWeight: '700', textTransform: 'uppercase', color: '#555' },
  cardTitleSpaced: { marginTop: 14 },
  bullet: { fontSize: 14, color: '#333', lineHeight: 20, marginTop: 6 },
  statusBox: { marginBottom: 16 },
  statusText: { fontSize: 15, color: '#222', marginBottom: 10 },
  blockedBox: {
    backgroundColor: '#FFF6E5',
    borderLeftWidth: 3,
    borderLeftColor: '#C98A2B',
    padding: 12,
    borderRadius: 6,
  },
  blockedText: { fontSize: 14, color: '#5A431A', lineHeight: 20 },
  codeBox: {
    backgroundColor: '#EAF2FE',
    borderRadius: 10,
    padding: 14,
  },
  codeLabel: { fontSize: 12, fontWeight: '700', color: '#1B4E8F', textTransform: 'uppercase' },
  code: {
    fontSize: 16,
    fontFamily: 'monospace',
    marginVertical: 10,
    color: '#12233A',
  },
  codeNote: { fontSize: 13, color: '#3C4A5A', lineHeight: 19 },
  primaryButton: {
    backgroundColor: '#1B6EF3',
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: 'center',
  },
  primaryButtonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  secondaryButton: { paddingVertical: 10 },
  secondaryButtonText: { color: '#1B6EF3', fontSize: 15 },
  dangerButton: {
    borderWidth: 1,
    borderColor: '#C0392B',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
  },
  dangerButtonText: { color: '#C0392B', fontSize: 15, fontWeight: '600' },
  error: { color: '#C0392B', marginBottom: 12 },
  hint: { fontSize: 13, color: '#777', marginTop: 12 },
});
