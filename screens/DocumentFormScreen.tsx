import React, { useState } from 'react';
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
  DOCUMENT_TYPES,
  DOCUMENT_TYPE_LABELS,
  GuardianAcknowledgementRequired,
  createDocument,
  updateDocument,
  type DocumentSummary,
  type DocumentType,
} from '../lib/documents';
import type { MrzExtraction } from '../lib/mrz';
import type { Traveler } from '../types/traveler';
import GuardianAcknowledgement from '../components/GuardianAcknowledgement';

/**
 * F1's confirm-or-correct step. The user reviews every field before saving,
 * regardless of how confident the extraction was -- so this screen is the same
 * whether the data came from a scan or was typed from scratch.
 */
export default function DocumentFormScreen({
  traveler,
  existing,
  extraction,
  imageUri,
  onDone,
  onCancel,
}: {
  traveler: Traveler;
  existing: DocumentSummary | null;
  /** Present when arriving from a scan; null for manual entry. */
  extraction: MrzExtraction | null;
  imageUri: string | null;
  onDone: (saved: DocumentSummary, imageUri: string | null) => void;
  onCancel: () => void;
}) {
  const draft = extraction?.draft ?? null;

  const [type, setType] = useState<DocumentType>(
    (draft?.type === 'unknown' ? 'passport' : draft?.type) ?? existing?.type ?? 'passport'
  );
  const [country, setCountry] = useState(draft?.country ?? existing?.country ?? '');
  const [documentNumber, setDocumentNumber] = useState(draft?.documentNumber ?? '');
  const [issueDate, setIssueDate] = useState(existing?.issue_date ?? '');
  const [expiryDate, setExpiryDate] = useState(draft?.expiryDate ?? existing?.expiry_date ?? '');
  const [isPrimary, setIsPrimary] = useState(existing?.is_primary ?? false);
  const [busy, setBusy] = useState(false);
  const [askingGuardian, setAskingGuardian] = useState(false);

  const invalid = new Set(extraction?.invalidFields ?? []);

  async function save(guardianAcknowledged = false) {
    if (!documentNumber.trim()) {
      Alert.alert('Document number required', 'Enter the number shown on the document.');
      return;
    }
    if (expiryDate && !/^\d{4}-\d{2}-\d{2}$/.test(expiryDate)) {
      Alert.alert('Check the expiry date', 'Use the format YYYY-MM-DD.');
      return;
    }

    setBusy(true);
    try {
      const payload = {
        type,
        country: country.trim().toUpperCase() || null,
        documentNumber: documentNumber.trim(),
        // Left off minor profiles by the server too -- this just avoids sending it.
        issueDate: traveler.is_minor ? null : issueDate || null,
        expiryDate: expiryDate || null,
        isPrimary,
      };

      const saved = existing
        ? await updateDocument(existing.id, payload)
        : await createDocument({ travelerId: traveler.id, ...payload, guardianAcknowledged });

      onDone(saved, imageUri);
    } catch (e) {
      if (e instanceof GuardianAcknowledgementRequired) {
        setAskingGuardian(true);
        return;
      }
      Alert.alert('Could not save', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (askingGuardian) {
    return (
      <GuardianAcknowledgement
        travelerName={traveler.name}
        onConfirm={() => {
          setAskingGuardian(false);
          void save(true);
        }}
        onCancel={() => setAskingGuardian(false)}
      />
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
      <Text style={styles.heading}>{existing ? 'Edit document' : 'Check the details'}</Text>
      <Text style={styles.sub}>
        {extraction
          ? `Read from the scan for ${traveler.name}. Correct anything that looks wrong before saving.`
          : `For ${traveler.name}.`}
      </Text>

      {extraction && <ExtractionNotice extraction={extraction} />}

      <Field label="Document type">
        <View style={styles.chips}>
          {DOCUMENT_TYPES.map((t) => (
            <Pressable
              key={t}
              style={[styles.chip, t === type && styles.chipOn]}
              onPress={() => setType(t)}
              disabled={busy}
            >
              <Text style={[styles.chipText, t === type && styles.chipTextOn]}>
                {DOCUMENT_TYPE_LABELS[t]}
              </Text>
            </Pressable>
          ))}
        </View>
      </Field>

      <Field label="Document number" flagged={invalid.has('documentNumber')}>
        <TextInput
          style={[styles.input, invalid.has('documentNumber') && styles.inputFlagged]}
          value={documentNumber}
          onChangeText={setDocumentNumber}
          autoCapitalize="characters"
          autoCorrect={false}
          placeholder="e.g. PA1234567"
          editable={!busy}
        />
      </Field>

      <Field label="Issuing country (3 letters)" flagged={invalid.has('issuingState')}>
        <TextInput
          style={[styles.input, invalid.has('issuingState') && styles.inputFlagged]}
          value={country}
          onChangeText={setCountry}
          autoCapitalize="characters"
          autoCorrect={false}
          maxLength={3}
          placeholder="AUS"
          editable={!busy}
        />
      </Field>

      <Field label="Expiry date (YYYY-MM-DD)" flagged={invalid.has('expirationDate')}>
        <TextInput
          style={[styles.input, invalid.has('expirationDate') && styles.inputFlagged]}
          value={expiryDate}
          onChangeText={setExpiryDate}
          placeholder="2032-01-15"
          autoCorrect={false}
          editable={!busy}
        />
      </Field>

      {/* F1: minor profiles capture only what the feature needs. The server
          drops this field for them regardless; hiding it avoids asking at all. */}
      {!traveler.is_minor && (
        <Field label="Issue date (YYYY-MM-DD, optional)">
          <TextInput
            style={styles.input}
            value={issueDate}
            onChangeText={setIssueDate}
            placeholder="2022-01-15"
            autoCorrect={false}
            editable={!busy}
          />
        </Field>
      )}

      {traveler.is_minor && (
        <Text style={styles.minorNote}>
          This is a child's profile, so TripVault stores only what it needs: type, number,
          issuing country and expiry.
        </Text>
      )}

      <Pressable
        style={styles.toggleRow}
        onPress={() => setIsPrimary((v) => !v)}
        disabled={busy}
      >
        <View style={[styles.checkbox, isPrimary && styles.checkboxOn]}>
          {isPrimary && <Text style={styles.checkboxTick}>✓</Text>}
        </View>
        <View style={styles.toggleText}>
          <Text style={styles.toggleLabel}>Travel on this one by default</Text>
          <Text style={styles.toggleHint}>
            For dual nationality — mark the one you usually travel on.
          </Text>
        </View>
      </Pressable>

      <Pressable style={[styles.save, busy && styles.disabled]} onPress={() => save()} disabled={busy}>
        {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.saveText}>Save document</Text>}
      </Pressable>

      <Pressable onPress={onCancel} disabled={busy} hitSlop={8}>
        <Text style={styles.cancel}>Cancel</Text>
      </Pressable>
    </ScrollView>
  );
}

/**
 * What the check digits said. This is the payoff of reading the MRZ rather than
 * the printed page: a misread is arithmetic that fails, not a judgement call,
 * so the user can be pointed at the specific field to re-check.
 */
function ExtractionNotice({ extraction }: { extraction: MrzExtraction }) {
  if (extraction.error) {
    return (
      <View style={[styles.notice, styles.noticeWarn]}>
        <Text style={styles.noticeTitleWarn}>Couldn't read the document automatically</Text>
        <Text style={styles.noticeBodyWarn}>{extraction.error} Enter the details by hand.</Text>
      </View>
    );
  }

  if (extraction.valid) {
    return (
      <View style={[styles.notice, styles.noticeOk]}>
        <Text style={styles.noticeTitleOk}>Read and checked</Text>
        <Text style={styles.noticeBodyOk}>
          Every check digit on the {extraction.format} zone matched
          {extraction.corrections.length > 0
            ? `, after correcting ${extraction.corrections.length} unclear character${
                extraction.corrections.length === 1 ? '' : 's'
              }`
            : ''}
          . Still worth a glance before saving.
        </Text>
      </View>
    );
  }

  return (
    <View style={[styles.notice, styles.noticeWarn]}>
      <Text style={styles.noticeTitleWarn}>Some fields didn't check out</Text>
      <Text style={styles.noticeBodyWarn}>
        {extraction.invalidFields.length > 0
          ? `The scan may have misread: ${extraction.invalidFields.join(', ')}. `
          : ''}
        The highlighted fields below need checking against the document.
      </Text>
    </View>
  );
}

function Field({
  label,
  flagged,
  children,
}: {
  label: string;
  flagged?: boolean;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.field}>
      <Text style={[styles.label, flagged && styles.labelFlagged]}>
        {label}
        {flagged ? ' — check this' : ''}
      </Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { padding: 24, gap: 18, paddingBottom: 48 },
  heading: { fontSize: 22, fontWeight: '700' },
  sub: { fontSize: 14, color: '#555', lineHeight: 20 },
  field: { gap: 8 },
  label: { fontSize: 13, color: '#666', textTransform: 'uppercase', letterSpacing: 0.5 },
  labelFlagged: { color: '#B25000' },
  input: {
    borderWidth: 1,
    borderColor: '#D0D0D0',
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
  },
  inputFlagged: { borderColor: '#E08A2E', backgroundColor: '#FFF9F0' },
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
  notice: { borderRadius: 8, borderWidth: 1, padding: 12, gap: 4 },
  noticeOk: { backgroundColor: '#EDF7ED', borderColor: '#3F8E3F' },
  noticeTitleOk: { fontWeight: '600', color: '#215821' },
  noticeBodyOk: { color: '#215821', fontSize: 13, lineHeight: 18 },
  noticeWarn: { backgroundColor: '#FFF4E5', borderColor: '#F0B429' },
  noticeTitleWarn: { fontWeight: '600', color: '#7A4E00' },
  noticeBodyWarn: { color: '#7A4E00', fontSize: 13, lineHeight: 18 },
  minorNote: { fontSize: 13, color: '#666', lineHeight: 18, fontStyle: 'italic' },
  toggleRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  checkbox: {
    width: 24,
    height: 24,
    borderRadius: 5,
    borderWidth: 1,
    borderColor: '#9A9A9A',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
  },
  checkboxOn: { backgroundColor: '#1B6EF3', borderColor: '#1B6EF3' },
  checkboxTick: { color: '#fff', fontSize: 15, fontWeight: '700' },
  toggleText: { flex: 1, gap: 2 },
  toggleLabel: { fontSize: 15, fontWeight: '500' },
  toggleHint: { fontSize: 13, color: '#666' },
  save: { backgroundColor: '#1B6EF3', borderRadius: 8, paddingVertical: 14, alignItems: 'center' },
  disabled: { opacity: 0.6 },
  saveText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  cancel: { textAlign: 'center', color: '#1B6EF3' },
});
