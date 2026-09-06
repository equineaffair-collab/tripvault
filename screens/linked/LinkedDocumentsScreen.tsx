/**
 * F9 mechanism 1 — the linked member's own documents.
 *
 * Their own, and nobody else's. The payoff of the whole feature is standing at
 * a check-in desk with your own passport scan on your phone and no signal, so
 * the screen's real content is the "Open scan" action and the honest note about
 * what happens once the file is saved.
 *
 * Document numbers are not shown here. Decrypting one is an Edge Function call
 * written to the audit log, and there is no reason a linked member needs the
 * number read off a screen when they have the scan itself.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import {
  listOwnDocuments,
  signedUrlForOwnDocument,
  type LinkedDocument,
} from '../../lib/familyAccess';
import { useAuth } from '../../contexts/AuthContext';

const TYPE_LABELS: Record<string, string> = {
  passport: 'Passport',
  visa: 'Visa',
  id_card: 'ID card',
  drivers_licence: 'Driver’s licence',
  other: 'Document',
};

export default function LinkedDocumentsScreen() {
  const { user, signOut } = useAuth();
  const [documents, setDocuments] = useState<LinkedDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      setDocuments(await listOwnDocuments());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load your documents.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh])
  );

  async function open(doc: LinkedDocument) {
    if (!doc.filePath) {
      Alert.alert('No scan saved', 'There is no image attached to this document.');
      return;
    }
    try {
      const url = await signedUrlForOwnDocument(doc.filePath);
      await Linking.openURL(url);
    } catch (e) {
      Alert.alert('Could not open', e instanceof Error ? e.message : 'Unknown error');
    }
  }

  return (
    <View style={styles.container}>
      <FlatList
        data={documents}
        keyExtractor={(d) => d.id}
        contentContainerStyle={styles.content}
        ListHeaderComponent={
          <>
            <Text style={styles.title}>Your documents</Text>
            <Text style={styles.sub}>
              Saved for you by whoever organizes your travel. Open a scan to save it to this
              phone, so you have it at an airport with no signal.
            </Text>
            <View style={styles.noteBox}>
              <Text style={styles.noteText}>
                Once you save a file to your phone it is outside TripVault entirely — it is
                protected by your phone's own lock screen and nothing else.
              </Text>
            </View>
            {error && <Text style={styles.error}>{error}</Text>}
          </>
        }
        ListEmptyComponent={
          loading ? (
            <ActivityIndicator style={styles.spinner} />
          ) : (
            <Text style={styles.empty}>
              No documents saved for you yet.
            </Text>
          )
        }
        renderItem={({ item }) => (
          <Pressable style={styles.row} onPress={() => void open(item)}>
            <View style={styles.rowMain}>
              <Text style={styles.rowName}>
                {TYPE_LABELS[item.type] ?? item.type}
                {item.country ? ` · ${item.country}` : ''}
              </Text>
              <Text style={styles.rowMeta}>
                {item.expiryDate ? `Expires ${item.expiryDate}` : 'No expiry recorded'}
              </Text>
            </View>
            <Text style={styles.openLink}>{item.filePath ? 'Open scan ›' : 'No scan'}</Text>
          </Pressable>
        )}
        ListFooterComponent={
          <View style={styles.footer}>
            <Text style={styles.footerNote}>Signed in as {user?.email ?? 'unknown'}</Text>
            <Pressable onPress={() => void signOut()} hitSlop={8}>
              <Text style={styles.signOut}>Log out</Text>
            </Pressable>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  content: { padding: 20, paddingBottom: 48 },
  title: { fontSize: 22, fontWeight: '700', marginBottom: 6 },
  sub: { fontSize: 15, color: '#555', lineHeight: 21 },
  noteBox: {
    backgroundColor: '#FFF6E5',
    borderLeftWidth: 3,
    borderLeftColor: '#C98A2B',
    padding: 12,
    borderRadius: 6,
    marginTop: 14,
  },
  noteText: { fontSize: 13, color: '#5A431A', lineHeight: 19 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#E2E6EA',
  },
  rowMain: { flex: 1 },
  rowName: { fontSize: 16, fontWeight: '600', color: '#1a1a1a' },
  rowMeta: { fontSize: 13, color: '#666', marginTop: 3 },
  openLink: { color: '#1B6EF3', fontSize: 14, fontWeight: '600' },
  empty: { fontSize: 14, color: '#777', marginTop: 16 },
  spinner: { marginTop: 30 },
  footer: { marginTop: 36, alignItems: 'flex-start' },
  footerNote: { fontSize: 13, color: '#777', marginBottom: 10 },
  signOut: { color: '#C0392B', fontSize: 15, fontWeight: '600' },
  error: { color: '#C0392B', marginTop: 12 },
});
