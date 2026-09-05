import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  DuplicateLoyaltyProgram,
  LOYALTY_TYPES,
  LOYALTY_TYPE_LABELS,
  createLoyaltyProgram,
  deleteLoyaltyProgram,
  groupByType,
  listLoyaltyPrograms,
  maskMembershipNumber,
  updateLoyaltyProgram,
  type LoyaltyProgram,
  type LoyaltyType,
} from '../lib/loyalty';
import type { Traveler } from '../types/traveler';

/**
 * F4 — loyalty programs for one traveler.
 *
 * Storage and quick reference when booking. There is deliberately nothing here
 * that fetches a point balance; F4 rules that out, and the test plan checks
 * nothing was half-built in that direction.
 */
export default function LoyaltyScreen({
  traveler,
  onBack,
}: {
  traveler: Traveler;
  onBack: () => void;
}) {
  const [programs, setPrograms] = useState<LoyaltyProgram[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<LoyaltyProgram | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setPrograms(await listLoyaltyPrograms(traveler.id));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [traveler.id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  function confirmDelete(p: LoyaltyProgram) {
    Alert.alert('Remove program', `Remove ${p.provider_name}?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          try {
            await deleteLoyaltyProgram(p.id);
            await refresh();
          } catch (e) {
            Alert.alert('Could not remove', e instanceof Error ? e.message : String(e));
          }
        },
      },
    ]);
  }

  if (formOpen) {
    return (
      <LoyaltyForm
        travelerId={traveler.id}
        existing={editing}
        onCancel={() => {
          setFormOpen(false);
          setEditing(null);
        }}
        onSaved={() => {
          setFormOpen(false);
          setEditing(null);
          void refresh();
        }}
      />
    );
  }

  const groups = groupByType(programs);

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Pressable onPress={onBack} hitSlop={8}>
          <Text style={styles.back}>‹ Travelers</Text>
        </Pressable>

        <Text style={styles.heading}>{traveler.name}'s programs</Text>
        <Text style={styles.sub}>
          Membership numbers for quick reference when booking. TripVault doesn't check point
          balances.
        </Text>

        {error && <Text style={styles.error}>{error}</Text>}
        {loading && <ActivityIndicator style={styles.spinner} />}

        {!loading && programs.length === 0 && !error && (
          <Text style={styles.empty}>
            Nothing saved yet. Add a frequent flyer or hotel number so it's to hand when you
            book.
          </Text>
        )}

        {groups.map((group) => (
          <View key={group.type} style={styles.group}>
            <Text style={styles.groupLabel}>{group.label}</Text>
            {group.programs.map((p) => (
              <Pressable
                key={p.id}
                style={styles.card}
                onPress={() => {
                  setEditing(p);
                  setFormOpen(true);
                }}
                onLongPress={() => confirmDelete(p)}
              >
                <View style={styles.cardTop}>
                  <Text style={styles.provider}>{p.provider_name}</Text>
                  {p.tier_status ? (
                    <View style={styles.tierBadge}>
                      <Text style={styles.tierBadgeText}>{p.tier_status}</Text>
                    </View>
                  ) : null}
                </View>

                <Pressable
                  onPress={() => setRevealed((r) => ({ ...r, [p.id]: !r[p.id] }))}
                  hitSlop={6}
                >
                  <Text style={styles.number}>
                    {revealed[p.id]
                      ? p.membership_number
                      : `${maskMembershipNumber(p.membership_number)}  (tap to show)`}
                  </Text>
                </Pressable>

                {p.notes ? <Text style={styles.notes}>{p.notes}</Text> : null}
              </Pressable>
            ))}
          </View>
        ))}
      </ScrollView>

      <Pressable
        style={styles.addButton}
        onPress={() => {
          setEditing(null);
          setFormOpen(true);
        }}
      >
        <Text style={styles.addButtonText}>Add program</Text>
      </Pressable>
    </View>
  );
}

function LoyaltyForm({
  travelerId,
  existing,
  onSaved,
  onCancel,
}: {
  travelerId: string;
  existing: LoyaltyProgram | null;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [type, setType] = useState<LoyaltyType>(existing?.type ?? 'airline');
  const [providerName, setProviderName] = useState(existing?.provider_name ?? '');
  const [membershipNumber, setMembershipNumber] = useState(existing?.membership_number ?? '');
  const [tierStatus, setTierStatus] = useState(existing?.tier_status ?? '');
  const [notes, setNotes] = useState(existing?.notes ?? '');
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!providerName.trim() || !membershipNumber.trim()) {
      Alert.alert('Missing details', 'A provider and a membership number are both needed.');
      return;
    }
    setBusy(true);
    try {
      const input = { type, providerName, membershipNumber, tierStatus, notes };
      if (existing) await updateLoyaltyProgram(existing.id, input);
      else await createLoyaltyProgram(travelerId, input);
      onSaved();
    } catch (e) {
      Alert.alert(
        e instanceof DuplicateLoyaltyProgram ? 'Already saved' : 'Could not save',
        e instanceof Error ? e.message : String(e)
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
      <Text style={styles.heading}>{existing ? 'Edit program' : 'Add program'}</Text>

      <Text style={styles.label}>Type</Text>
      <View style={styles.chips}>
        {LOYALTY_TYPES.map((t) => (
          <Pressable
            key={t}
            style={[styles.chip, t === type && styles.chipOn]}
            onPress={() => setType(t)}
            disabled={busy}
          >
            <Text style={[styles.chipText, t === type && styles.chipTextOn]}>
              {LOYALTY_TYPE_LABELS[t]}
            </Text>
          </Pressable>
        ))}
      </View>

      <Text style={styles.label}>Provider</Text>
      <TextInput
        style={styles.input}
        value={providerName}
        onChangeText={setProviderName}
        placeholder="e.g. Qantas Frequent Flyer"
        editable={!busy}
      />

      <Text style={styles.label}>Membership number</Text>
      <TextInput
        style={styles.input}
        value={membershipNumber}
        onChangeText={setMembershipNumber}
        placeholder="e.g. 1234567890"
        autoCapitalize="characters"
        autoCorrect={false}
        editable={!busy}
      />

      <Text style={styles.label}>Tier (optional)</Text>
      <TextInput
        style={styles.input}
        value={tierStatus}
        onChangeText={setTierStatus}
        placeholder="e.g. Gold"
        editable={!busy}
      />

      <Text style={styles.label}>Notes (optional)</Text>
      <TextInput
        style={[styles.input, styles.multiline]}
        value={notes}
        onChangeText={setNotes}
        placeholder="Anything worth remembering when booking"
        multiline
        editable={!busy}
      />

      <Pressable style={[styles.addButton, busy && styles.disabled]} onPress={save} disabled={busy}>
        {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.addButtonText}>Save</Text>}
      </Pressable>

      <Pressable onPress={onCancel} disabled={busy} hitSlop={8}>
        <Text style={styles.cancel}>Cancel</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  scroll: { padding: 24, gap: 12, paddingBottom: 40 },
  back: { color: '#1B6EF3', fontSize: 15, fontWeight: '600' },
  heading: { fontSize: 22, fontWeight: '700', marginTop: 4 },
  sub: { fontSize: 14, color: '#555', lineHeight: 20 },
  error: { color: '#C4342B', fontSize: 14 },
  empty: { color: '#666', fontSize: 15, lineHeight: 21, marginTop: 8 },
  spinner: { marginTop: 16 },
  group: { gap: 8, marginTop: 12 },
  groupLabel: {
    fontSize: 13,
    color: '#666',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    fontWeight: '600',
  },
  card: {
    borderWidth: 1,
    borderColor: '#E4E4E4',
    borderRadius: 10,
    padding: 14,
    gap: 6,
  },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  provider: { flex: 1, fontSize: 16, fontWeight: '600' },
  tierBadge: {
    backgroundColor: '#FFF4E5',
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  tierBadgeText: { color: '#7A4E00', fontSize: 12, fontWeight: '700' },
  number: { fontSize: 15, letterSpacing: 1, color: '#1B6EF3', paddingVertical: 2 },
  notes: { fontSize: 13, color: '#666', lineHeight: 18 },
  label: {
    fontSize: 13,
    color: '#666',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: 8,
  },
  input: {
    borderWidth: 1,
    borderColor: '#D0D0D0',
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
  },
  multiline: { minHeight: 80, textAlignVertical: 'top' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    borderWidth: 1,
    borderColor: '#D0D0D0',
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  chipOn: { backgroundColor: '#1B6EF3', borderColor: '#1B6EF3' },
  chipText: { fontSize: 14, color: '#333' },
  chipTextOn: { color: '#fff', fontWeight: '600' },
  addButton: {
    backgroundColor: '#1B6EF3',
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: 'center',
    marginHorizontal: 24,
    marginBottom: 16,
  },
  disabled: { opacity: 0.6 },
  addButtonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  cancel: { textAlign: 'center', color: '#1B6EF3', marginTop: 4 },
});
