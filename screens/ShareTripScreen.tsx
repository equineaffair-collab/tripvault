/**
 * F9 mechanism 2, organizer side — share links for one trip.
 *
 * Separate screen from FamilyAccessScreen on purpose. They look similar and are
 * not: this one hands a bearer link to someone with no account, and the copy
 * has to keep saying so. Merging them into one "sharing" screen would blur the
 * distinction the whole feature rests on.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  SHARE_DOCUMENTS_WARNING,
  SHARE_LINK_NOTE,
  createShareLink,
  deleteShareLink,
  describeShareLink,
  listShareLinks,
  revokeShareLink,
  shareBlockReason,
  shareLinkStatus,
  shareUrl,
  supabaseProjectUrl,
  type ShareLink,
} from '../lib/tripSharing';
import { getCurrentTier, type Tier } from '../lib/subscription';

type Props = {
  tripId: string;
  tripName: string;
  onBack: () => void;
};

export default function ShareTripScreen({ tripId, tripName, onBack }: Props) {
  const [tier, setTier] = useState<Tier>('free');
  const [links, setLinks] = useState<ShareLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [label, setLabel] = useState('');
  const [withDocuments, setWithDocuments] = useState(false);
  const [freshUrl, setFreshUrl] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const [currentTier, existing] = await Promise.all([getCurrentTier(), listShareLinks(tripId)]);
      setTier(currentTier);
      setLinks(existing);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load share links.');
    } finally {
      setLoading(false);
    }
  }, [tripId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const blocked = shareBlockReason(tier);

  async function handleCreate() {
    setBusy(true);
    setError(null);
    try {
      const created = await createShareLink({
        tripId,
        label: label.trim() || null,
        includesDocuments: withDocuments,
      });
      setFreshUrl(shareUrl(supabaseProjectUrl(), created.token));
      setLabel('');
      setWithDocuments(false);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create a link.');
    } finally {
      setBusy(false);
    }
  }

  function confirmCreate() {
    if (!withDocuments) return void handleCreate();

    // The one setting that turns a link about a holiday into a link to a
    // passport scan gets an explicit confirmation, worded as what it does
    // rather than as "are you sure".
    Alert.alert('Include documents?', SHARE_DOCUMENTS_WARNING, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Include documents', style: 'destructive', onPress: () => void handleCreate() },
    ]);
  }

  function confirmRevoke(link: ShareLink) {
    Alert.alert(
      'Revoke this link',
      'It will stop working immediately, for everyone who has it. This cannot be undone — ' +
        'create a new link if you need one again.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Revoke',
          style: 'destructive',
          onPress: async () => {
            try {
              await revokeShareLink(link.id);
              setFreshUrl(null);
              await refresh();
            } catch (e) {
              Alert.alert('Could not revoke', e instanceof Error ? e.message : 'Unknown error');
            }
          },
        },
      ]
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Pressable onPress={onBack} hitSlop={12}>
        <Text style={styles.back}>‹ Back</Text>
      </Pressable>

      <Text style={styles.title}>Share {tripName}</Text>
      <Text style={styles.lede}>{SHARE_LINK_NOTE}</Text>

      {loading ? (
        <ActivityIndicator style={styles.spinner} />
      ) : blocked ? (
        <View style={styles.blockedBox}>
          <Text style={styles.blockedText}>{blocked}</Text>
        </View>
      ) : (
        <>
          {error && <Text style={styles.error}>{error}</Text>}

          {freshUrl && (
            <View style={styles.codeBox}>
              <Text style={styles.codeLabel}>New link — copy it now</Text>
              <Text selectable style={styles.code}>
                {freshUrl}
              </Text>
              <Text style={styles.codeNote}>
                Only the link's fingerprint is stored, so this cannot be shown again. If it gets
                lost, revoke it and make a new one.
              </Text>
            </View>
          )}

          <View style={styles.form}>
            <Text style={styles.fieldLabel}>Who is it for?</Text>
            <TextInput
              style={styles.input}
              value={label}
              onChangeText={setLabel}
              placeholder="Mum, the house sitter…"
              maxLength={60}
            />
            <Text style={styles.fieldHint}>
              Just for your own records, so you know which link to revoke later.
            </Text>

            <View style={styles.switchRow}>
              <View style={styles.switchText}>
                <Text style={styles.fieldLabel}>Include documents</Text>
                <Text style={styles.fieldHint}>
                  Off by default. Passport scans for everyone on this trip, viewable by anyone
                  with the link. Document numbers are never shared.
                </Text>
              </View>
              <Switch value={withDocuments} onValueChange={setWithDocuments} />
            </View>

            <Pressable style={styles.primaryButton} onPress={confirmCreate} disabled={busy}>
              <Text style={styles.primaryButtonText}>{busy ? 'Creating…' : 'Create link'}</Text>
            </Pressable>
          </View>

          <Text style={styles.sectionTitle}>Links for this trip</Text>
          {links.length === 0 ? (
            <Text style={styles.empty}>None yet.</Text>
          ) : (
            links.map((link) => {
              const status = shareLinkStatus(link);
              return (
                <View key={link.id} style={styles.linkRow}>
                  <Text style={[styles.linkText, status !== 'active' && styles.linkDead]}>
                    {describeShareLink(link)}
                  </Text>
                  {status === 'active' ? (
                    <Pressable onPress={() => confirmRevoke(link)} hitSlop={8}>
                      <Text style={styles.revoke}>Revoke</Text>
                    </Pressable>
                  ) : (
                    <Pressable
                      onPress={async () => {
                        await deleteShareLink(link.id);
                        await refresh();
                      }}
                      hitSlop={8}
                    >
                      <Text style={styles.remove}>Remove</Text>
                    </Pressable>
                  )}
                </View>
              );
            })
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
  blockedBox: {
    backgroundColor: '#FFF6E5',
    borderLeftWidth: 3,
    borderLeftColor: '#C98A2B',
    padding: 12,
    borderRadius: 6,
  },
  blockedText: { fontSize: 14, color: '#5A431A', lineHeight: 20 },
  codeBox: { backgroundColor: '#EAF2FE', borderRadius: 10, padding: 14, marginBottom: 18 },
  codeLabel: { fontSize: 12, fontWeight: '700', color: '#1B4E8F', textTransform: 'uppercase' },
  code: { fontSize: 13, fontFamily: 'monospace', marginVertical: 10, color: '#12233A' },
  codeNote: { fontSize: 13, color: '#3C4A5A', lineHeight: 19 },
  form: { marginBottom: 24 },
  fieldLabel: { fontSize: 14, fontWeight: '600', color: '#222' },
  fieldHint: { fontSize: 13, color: '#666', lineHeight: 18, marginTop: 4 },
  input: {
    borderWidth: 1,
    borderColor: '#D5DAE0',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    marginTop: 6,
  },
  switchRow: { flexDirection: 'row', alignItems: 'center', marginTop: 18, marginBottom: 18 },
  switchText: { flex: 1, paddingRight: 12 },
  primaryButton: {
    backgroundColor: '#1B6EF3',
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: 'center',
  },
  primaryButtonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  sectionTitle: { fontSize: 13, fontWeight: '700', textTransform: 'uppercase', color: '#555' },
  empty: { fontSize: 14, color: '#777', marginTop: 10 },
  linkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#E2E6EA',
  },
  linkText: { flex: 1, fontSize: 14, color: '#222', lineHeight: 19, paddingRight: 12 },
  linkDead: { color: '#888' },
  revoke: { color: '#C0392B', fontSize: 14, fontWeight: '600' },
  remove: { color: '#777', fontSize: 14 },
  error: { color: '#C0392B', marginBottom: 12 },
});
