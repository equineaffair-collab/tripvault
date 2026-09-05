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
import { isSupabaseConfigured, supabase } from '../lib/supabase';
import { listTravelers } from '../lib/travelers';
import type { Traveler } from '../types/traveler';
import {
  DOCUMENT_TYPE_LABELS,
  deleteDocument,
  listAllDocuments,
  revealDocumentNumber,
  scanObjectPath,
  updateDocument,
  type DocumentSummary,
} from '../lib/documents';
import { isScanningAvailable, scanDocument } from '../lib/scan';
import type { MrzExtraction } from '../lib/mrz';
import DocumentFormScreen from './DocumentFormScreen';

type Mode =
  | { kind: 'list' }
  | { kind: 'pickTraveler' }
  | { kind: 'form'; traveler: Traveler; extraction: MrzExtraction | null; imageUri: string | null };

export default function DocumentsScreen() {
  const { user } = useAuth();
  const [travelers, setTravelers] = useState<Traveler[]>([]);
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>({ kind: 'list' });
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [scanning, setScanning] = useState(false);

  const refresh = useCallback(async () => {
    if (!isSupabaseConfigured) {
      setLoading(false);
      setError('Supabase is not configured yet — add your keys to .env.');
      return;
    }
    setLoading(true);
    try {
      const [t, d] = await Promise.all([listTravelers(), listAllDocuments()]);
      setTravelers(t);
      setDocuments(d);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * Upload the scan after the row exists: the storage path embeds the document
   * id, and the policies require the caller's own user id as the first segment.
   */
  async function attachScan(doc: DocumentSummary, imageUri: string) {
    if (!user) return;
    const path = scanObjectPath(user.id, doc.traveler_id, doc.id, 'jpg');
    const response = await fetch(imageUri);
    const bytes = await response.arrayBuffer();

    const { error: upErr } = await supabase.storage
      .from('documents')
      .upload(path, bytes, { contentType: 'image/jpeg', upsert: true });
    if (upErr) throw new Error(upErr.message);

    await updateDocument(doc.id, { filePath: path });
  }

  async function startScan(traveler: Traveler) {
    setScanning(true);
    try {
      const result = await scanDocument();
      switch (result.status) {
        case 'cancelled':
          return;
        case 'unavailable':
          Alert.alert(
            'Scanning needs a development build',
            "The camera scanner uses native code that Expo Go can't load. You can still enter the document by hand.",
            [
              { text: 'Cancel', style: 'cancel' },
              {
                text: 'Enter by hand',
                onPress: () => setMode({ kind: 'form', traveler, extraction: null, imageUri: null }),
              },
            ]
          );
          return;
        case 'error':
          Alert.alert('Scan failed', result.message);
          return;
        case 'ok':
          setMode({
            kind: 'form',
            traveler,
            extraction: result.extraction,
            imageUri: result.imageUri,
          });
      }
    } finally {
      setScanning(false);
    }
  }

  async function reveal(doc: DocumentSummary) {
    try {
      setRevealed((r) => ({ ...r, [doc.id]: '…' }));
      const number = await revealDocumentNumber(doc.id);
      setRevealed((r) => ({ ...r, [doc.id]: number }));
    } catch (e) {
      setRevealed((r) => {
        const next = { ...r };
        delete next[doc.id];
        return next;
      });
      Alert.alert('Could not show the number', e instanceof Error ? e.message : String(e));
    }
  }

  function confirmDelete(doc: DocumentSummary) {
    Alert.alert('Delete document', 'This removes it permanently. Continue?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            await deleteDocument(doc.id);
            await refresh();
          } catch (e) {
            Alert.alert('Could not delete', e instanceof Error ? e.message : String(e));
          }
        },
      },
    ]);
  }

  // ---- traveler picker -----------------------------------------------------
  if (mode.kind === 'pickTraveler') {
    return (
      <View style={styles.container}>
        <View style={styles.pickHeader}>
          <Text style={styles.heading}>Whose document is it?</Text>
        </View>
        <FlatList
          data={travelers}
          keyExtractor={(t) => t.id}
          contentContainerStyle={styles.listContent}
          renderItem={({ item }) => (
            <Pressable style={styles.row} onPress={() => void startScan(item)} disabled={scanning}>
              <View style={styles.rowMain}>
                <Text style={styles.rowName}>{item.name}</Text>
                <Text style={styles.rowMeta}>
                  {item.is_minor ? 'Child profile' : 'Scan or enter a document'}
                </Text>
              </View>
              {scanning ? <ActivityIndicator /> : <Text style={styles.chevron}>›</Text>}
            </Pressable>
          )}
          ListEmptyComponent={
            <Text style={styles.empty}>
              Add a traveler on the Profile tab first — documents attach to a person.
            </Text>
          }
        />
        <Pressable style={styles.secondary} onPress={() => setMode({ kind: 'list' })}>
          <Text style={styles.secondaryText}>Cancel</Text>
        </Pressable>
      </View>
    );
  }

  // ---- confirm-or-correct form --------------------------------------------
  if (mode.kind === 'form') {
    return (
      <DocumentFormScreen
        traveler={mode.traveler}
        existing={null}
        extraction={mode.extraction}
        imageUri={mode.imageUri}
        onCancel={() => setMode({ kind: 'list' })}
        onDone={async (saved, imageUri) => {
          setMode({ kind: 'list' });
          if (imageUri) {
            try {
              await attachScan(saved, imageUri);
            } catch (e) {
              // The document itself saved; only the image failed. Say so rather
              // than implying the whole thing was lost.
              Alert.alert(
                'Document saved, scan not attached',
                e instanceof Error ? e.message : String(e)
              );
            }
          }
          await refresh();
        }}
      />
    );
  }

  // ---- list ----------------------------------------------------------------
  const nameFor = (id: string) => travelers.find((t) => t.id === id)?.name ?? 'Unknown traveler';

  return (
    <View style={styles.container}>
      <FlatList
        data={documents}
        keyExtractor={(d) => d.id}
        contentContainerStyle={styles.listContent}
        ListHeaderComponent={
          <View style={styles.headerBlock}>
            <Text style={styles.heading}>Documents</Text>
            {error && <Text style={styles.error}>{error}</Text>}
            {!isScanningAvailable() && (
              <View style={styles.notice}>
                <Text style={styles.noticeTitle}>Camera scanning needs a dev build</Text>
                <Text style={styles.noticeBody}>
                  The scanner and on-device text recognition are native modules Expo Go can't
                  load. Manual entry works now; run an EAS dev build to scan.
                </Text>
              </View>
            )}
          </View>
        }
        ListEmptyComponent={
          loading ? (
            <ActivityIndicator style={styles.spinner} />
          ) : error ? null : (
            <Text style={styles.empty}>
              No documents yet. Add a passport and TripVault will warn you before it expires.
            </Text>
          )
        }
        renderItem={({ item }) => (
          <DocumentRow
            doc={item}
            travelerName={nameFor(item.traveler_id)}
            revealedNumber={revealed[item.id]}
            onReveal={() => void reveal(item)}
            onDelete={() => confirmDelete(item)}
          />
        )}
      />

      <Pressable
        style={styles.addButton}
        onPress={() => setMode({ kind: 'pickTraveler' })}
        disabled={loading}
      >
        <Text style={styles.addButtonText}>Add document</Text>
      </Pressable>
    </View>
  );
}

/** Days until expiry, or null when there is no expiry date. */
function daysUntil(dateIso: string | null): number | null {
  if (!dateIso) return null;
  const then = new Date(`${dateIso}T00:00:00Z`).getTime();
  if (Number.isNaN(then)) return null;
  return Math.round((then - Date.now()) / 86_400_000);
}

function DocumentRow({
  doc,
  travelerName,
  revealedNumber,
  onReveal,
  onDelete,
}: {
  doc: DocumentSummary;
  travelerName: string;
  revealedNumber: string | undefined;
  onReveal: () => void;
  onDelete: () => void;
}) {
  const days = daysUntil(doc.expiry_date);
  // F2 owns the actual reminders; this is just the at-a-glance state.
  const expiryTone =
    days === null ? 'none' : days < 0 ? 'expired' : days < 183 ? 'soon' : 'ok';

  return (
    <Pressable style={styles.card} onLongPress={onDelete}>
      <View style={styles.cardTop}>
        <Text style={styles.cardTitle}>
          {DOCUMENT_TYPE_LABELS[doc.type]}
          {doc.country ? ` · ${doc.country}` : ''}
        </Text>
        {doc.is_primary && (
          <View style={styles.primaryBadge}>
            <Text style={styles.primaryBadgeText}>Primary</Text>
          </View>
        )}
      </View>

      <Text style={styles.cardOwner}>{travelerName}</Text>

      <Pressable onPress={onReveal} hitSlop={6}>
        <Text style={styles.number}>
          {revealedNumber ?? '•••••••••  Tap to show number'}
        </Text>
      </Pressable>

      {doc.expiry_date && (
        <Text
          style={[
            styles.expiry,
            expiryTone === 'expired' && styles.expiryBad,
            expiryTone === 'soon' && styles.expirySoon,
          ]}
        >
          {expiryTone === 'expired'
            ? `Expired ${doc.expiry_date}`
            : `Expires ${doc.expiry_date}${
                expiryTone === 'soon' ? ` — ${days} days, renew before travelling` : ''
              }`}
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  listContent: { padding: 24, paddingBottom: 8 },
  pickHeader: { paddingHorizontal: 24, paddingTop: 24 },
  headerBlock: { gap: 12, marginBottom: 8 },
  heading: { fontSize: 22, fontWeight: '700' },
  error: { color: '#C4342B', fontSize: 14 },
  empty: { color: '#666', fontSize: 15, lineHeight: 21 },
  spinner: { marginTop: 20 },
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
  card: {
    borderWidth: 1,
    borderColor: '#E4E4E4',
    borderRadius: 10,
    padding: 14,
    marginTop: 12,
    gap: 6,
  },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  cardTitle: { flex: 1, fontSize: 16, fontWeight: '600' },
  cardOwner: { fontSize: 14, color: '#666' },
  primaryBadge: {
    backgroundColor: '#EAF2FF',
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  primaryBadgeText: { color: '#0B3E8F', fontSize: 12, fontWeight: '700' },
  number: { fontSize: 15, letterSpacing: 1, color: '#1B6EF3', paddingVertical: 4 },
  expiry: { fontSize: 14, color: '#444' },
  expirySoon: { color: '#B25000', fontWeight: '500' },
  expiryBad: { color: '#C4342B', fontWeight: '600' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#E4E4E4',
    borderRadius: 8,
    padding: 14,
    marginTop: 10,
    gap: 10,
  },
  rowMain: { flex: 1, gap: 2 },
  rowName: { fontSize: 16, fontWeight: '600' },
  rowMeta: { fontSize: 14, color: '#666' },
  chevron: { fontSize: 24, color: '#9A9A9A' },
  addButton: {
    backgroundColor: '#1B6EF3',
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: 'center',
    margin: 24,
    marginTop: 8,
  },
  addButtonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  secondary: { paddingVertical: 16, alignItems: 'center', marginBottom: 8 },
  secondaryText: { color: '#1B6EF3', fontSize: 15, fontWeight: '600' },
});
