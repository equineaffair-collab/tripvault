import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useAuth } from '../contexts/AuthContext';
import { isSupabaseConfigured } from '../lib/supabase';
import {
  createTraveler,
  deleteTraveler,
  listTravelers,
  updateTraveler,
} from '../lib/travelers';
import { RELATIONSHIP_LABELS, type Relationship, type Traveler } from '../types/traveler';
import TravelerFormModal from './TravelerFormModal';
import LoyaltyScreen from './LoyaltyScreen';
import AccountScreen from './AccountScreen';
import FamilyAccessScreen from './FamilyAccessScreen';
import AcceptInviteScreen from './AcceptInviteScreen';

type Props = {
  /**
   * F9: accepting an invite turns this account into a linked family member,
   * which is a different app entirely. The navigator owns that decision, so
   * this screen tells it to look again rather than deciding for itself.
   */
  onRoleMayHaveChanged?: () => void;
};

export default function ProfileScreen({ onRoleMayHaveChanged }: Props) {
  const { user, signOut } = useAuth();
  const [travelers, setTravelers] = useState<Traveler[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  // F4 lives one level down from a traveler rather than in its own tab: loyalty
  // numbers belong to a person, and the tab bar is already at three.
  const [loyaltyFor, setLoyaltyFor] = useState<Traveler | null>(null);
  const [accountOpen, setAccountOpen] = useState(false);
  // F9's two sides, each on its own screen: granting someone else access, and
  // redeeming a code someone gave you.
  const [accessFor, setAccessFor] = useState<Traveler | null>(null);
  const [acceptOpen, setAcceptOpen] = useState(false);
  const [editing, setEditing] = useState<Traveler | null>(null);

  const refresh = useCallback(async () => {
    if (!isSupabaseConfigured) {
      setLoading(false);
      return;
    }
    setError(null);
    try {
      setTravelers(await listTravelers());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load traveler profiles.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleSubmit(values: { name: string; relationship: Relationship }) {
    if (editing) {
      await updateTraveler(editing.id, values);
    } else {
      await createTraveler(values);
    }
    await refresh();
  }

  function confirmDelete(traveler: Traveler) {
    Alert.alert(
      'Delete traveler',
      `Delete ${traveler.name}? Anything attached to this profile goes with it.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              await deleteTraveler(traveler.id);
              await refresh();
            } catch (e) {
              Alert.alert('Could not delete', e instanceof Error ? e.message : 'Unknown error');
            }
          },
        },
      ]
    );
  }

  function confirmSignOut() {
    Alert.alert('Log out', 'Log out of TripVault on this device?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Log out', style: 'destructive', onPress: () => void signOut() },
    ]);
  }

  if (loyaltyFor) {
    return <LoyaltyScreen traveler={loyaltyFor} onBack={() => setLoyaltyFor(null)} />;
  }

  if (accountOpen) {
    return <AccountScreen onBack={() => setAccountOpen(false)} />;
  }

  if (accessFor) {
    // Re-read from the refreshed list so the screen reflects a link that was
    // just granted or removed, rather than the row captured when it opened.
    const current = travelers.find((t) => t.id === accessFor.id) ?? accessFor;
    return (
      <FamilyAccessScreen
        traveler={current}
        onBack={() => setAccessFor(null)}
        onChanged={refresh}
      />
    );
  }

  if (acceptOpen) {
    return (
      <AcceptInviteScreen
        onBack={() => setAcceptOpen(false)}
        onAccepted={() => {
          setAcceptOpen(false);
          onRoleMayHaveChanged?.();
        }}
      />
    );
  }

  return (
    <View style={styles.container}>
      <FlatList
        data={travelers}
        keyExtractor={(t) => t.id}
        contentContainerStyle={styles.listContent}
        ListHeaderComponent={
          <View style={styles.header}>
            <View style={styles.block}>
              <Text style={styles.label}>Logged in as</Text>
              <Text style={styles.value}>{user?.email ?? 'unknown'}</Text>
            </View>

            {!isSupabaseConfigured && (
              <View style={styles.notice}>
                <Text style={styles.noticeTitle}>Supabase isn't configured yet</Text>
                <Text style={styles.noticeBody}>
                  Add EXPO_PUBLIC_SUPABASE_ANON_KEY to .env and restart with npx expo start
                  --clear. Traveler profiles can't load until then.
                </Text>
              </View>
            )}

            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>Traveler profiles</Text>
              <Pressable
                style={styles.addButton}
                onPress={() => {
                  setEditing(null);
                  setModalOpen(true);
                }}
              >
                <Text style={styles.addButtonText}>+ Add</Text>
              </Pressable>
            </View>

            {error && <Text style={styles.error}>{error}</Text>}
          </View>
        }
        ListEmptyComponent={
          loading ? (
            <ActivityIndicator style={styles.spinner} />
          ) : (
            <Text style={styles.empty}>
              No traveler profiles yet. Add yourself first, then anyone you organize travel for.
            </Text>
          )
        }
        renderItem={({ item }) => (
          <Pressable
            style={styles.row}
            onPress={() => {
              setEditing(item);
              setModalOpen(true);
            }}
            onLongPress={() => confirmDelete(item)}
          >
            <View style={styles.rowMain}>
              <Text style={styles.rowName}>{item.name}</Text>
              <Text style={styles.rowMeta}>{RELATIONSHIP_LABELS[item.relationship]}</Text>
            </View>
            {item.is_minor && (
              <View style={styles.minorBadge}>
                <Text style={styles.minorBadgeText}>Minor</Text>
              </View>
            )}
            {item.linked_auth_user_id && (
              <View style={styles.linkedBadge}>
                <Text style={styles.linkedBadgeText}>Own login</Text>
              </View>
            )}
            <Pressable
              onPress={() => setLoyaltyFor(item)}
              hitSlop={10}
              style={styles.loyaltyLink}
            >
              <Text style={styles.loyaltyLinkText}>Loyalty ›</Text>
            </Pressable>
            <Pressable onPress={() => setAccessFor(item)} hitSlop={10} style={styles.loyaltyLink}>
              <Text style={styles.loyaltyLinkText}>Access ›</Text>
            </Pressable>
          </Pressable>
        )}
        ListFooterComponent={
          <>
          <Pressable style={styles.dataLink} onPress={() => setAcceptOpen(true)}>
            <Text style={styles.dataLinkText}>Someone gave me an invite code</Text>
          </Pressable>
          <Pressable style={styles.dataLink} onPress={() => setAccountOpen(true)}>
            <Text style={styles.dataLinkText}>Export or delete my data</Text>
          </Pressable>
          <Pressable style={styles.signOut} onPress={confirmSignOut}>
            <Text style={styles.signOutText}>Log out</Text>
          </Pressable>
          </>
        }
      />

      <TravelerFormModal
        visible={modalOpen}
        editing={editing}
        onClose={() => setModalOpen(false)}
        onSubmit={handleSubmit}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  linkedBadge: {
    backgroundColor: '#E4F1E8',
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 2,
    marginRight: 8,
  },
  linkedBadgeText: { fontSize: 11, fontWeight: '700', color: '#1F5B33' },
  listContent: { padding: 24, gap: 8 },
  header: { gap: 16, marginBottom: 8 },
  block: { gap: 4 },
  label: { fontSize: 13, color: '#666', textTransform: 'uppercase', letterSpacing: 0.5 },
  value: { fontSize: 17, fontWeight: '500' },
  notice: {
    backgroundColor: '#FFF4E5',
    borderColor: '#F0B429',
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    gap: 4,
  },
  noticeTitle: { fontWeight: '600', color: '#7A4E00' },
  noticeBody: { color: '#7A4E00', fontSize: 13, lineHeight: 18 },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sectionTitle: { fontSize: 18, fontWeight: '600' },
  addButton: { paddingVertical: 6, paddingHorizontal: 12 },
  addButtonText: { color: '#1B6EF3', fontSize: 16, fontWeight: '600' },
  error: { color: '#C4342B', fontSize: 14 },
  spinner: { marginTop: 20 },
  empty: { color: '#666', fontSize: 15, lineHeight: 21, marginTop: 8 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#E4E4E4',
    borderRadius: 10,
    paddingVertical: 14,
    paddingHorizontal: 16,
    gap: 12,
  },
  rowMain: { flex: 1, gap: 2 },
  rowName: { fontSize: 16, fontWeight: '500' },
  rowMeta: { fontSize: 13, color: '#666' },
  minorBadge: {
    backgroundColor: '#EAF2FF',
    borderRadius: 12,
    paddingVertical: 4,
    paddingHorizontal: 10,
  },
  minorBadgeText: { color: '#12448F', fontSize: 12, fontWeight: '600' },
  loyaltyLink: { paddingLeft: 10, paddingVertical: 4 },
  loyaltyLinkText: { color: '#1B6EF3', fontSize: 14, fontWeight: '600' },
  dataLink: { paddingVertical: 16, alignItems: 'center' },
  dataLinkText: { color: '#1B6EF3', fontSize: 15, fontWeight: '600' },
  signOut: {
    marginTop: 32,
    borderWidth: 1,
    borderColor: '#C4342B',
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: 'center',
  },
  signOutText: { color: '#C4342B', fontSize: 16, fontWeight: '600' },
});
