import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  impliesMinor,
  RELATIONSHIP_LABELS,
  RELATIONSHIPS,
  type Relationship,
  type Traveler,
} from '../types/traveler';

type Props = {
  visible: boolean;
  /** Existing profile to edit, or null to create a new one. */
  editing: Traveler | null;
  onClose: () => void;
  onSubmit: (values: { name: string; relationship: Relationship }) => Promise<void>;
};

export default function TravelerFormModal({ visible, editing, onClose, onSubmit }: Props) {
  // A full-screen Modal sits outside the navigator, so it gets no header and no
  // safe-area inset of its own -- without this the title renders underneath the
  // status bar clock.
  const insets = useSafeAreaInsets();
  const [name, setName] = useState('');
  const [relationship, setRelationship] = useState<Relationship>('self');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    setName(editing?.name ?? '');
    setRelationship(editing?.relationship ?? 'self');
    setError(null);
    setBusy(false);
  }, [visible, editing]);

  async function submit() {
    if (!name.trim()) {
      setError('Enter a name for this traveler.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit({ name, relationship });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet">
      <ScrollView
        contentContainerStyle={[
          styles.container,
          { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 },
        ]}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.title}>{editing ? 'Edit traveler' : 'Add traveler'}</Text>

        <Text style={styles.label}>Name</Text>
        <TextInput
          style={styles.input}
          value={name}
          onChangeText={setName}
          placeholder="e.g. Sam Whitfield"
          autoCapitalize="words"
          editable={!busy}
        />

        <Text style={styles.label}>Relationship to you</Text>
        <View style={styles.options}>
          {RELATIONSHIPS.map((r) => {
            const selected = r === relationship;
            return (
              <Pressable
                key={r}
                style={[styles.option, selected && styles.optionSelected]}
                onPress={() => setRelationship(r)}
                disabled={busy}
              >
                <Text style={[styles.optionText, selected && styles.optionTextSelected]}>
                  {RELATIONSHIP_LABELS[r]}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {impliesMinor(relationship) && (
          <View style={styles.minorNotice}>
            <Text style={styles.minorNoticeText}>
              This profile will be marked as a minor. Adding documents to it will require you to
              confirm you're the child's parent or legal guardian, and TripVault will store less
              optional detail on this profile than an adult one.
            </Text>
          </View>
        )}

        {error && <Text style={styles.error}>{error}</Text>}

        <View style={styles.actions}>
          <Pressable style={[styles.button, styles.cancel]} onPress={onClose} disabled={busy}>
            <Text style={styles.cancelText}>Cancel</Text>
          </Pressable>
          <Pressable
            style={[styles.button, styles.save, busy && styles.buttonDisabled]}
            onPress={submit}
            disabled={busy}
          >
            {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.saveText}>Save</Text>}
          </Pressable>
        </View>
      </ScrollView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { padding: 24, gap: 10 },
  title: { fontSize: 24, fontWeight: '700', marginBottom: 8 },
  label: { fontSize: 13, color: '#666', textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 8 },
  input: {
    borderWidth: 1,
    borderColor: '#D0D0D0',
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
  },
  options: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  option: {
    borderWidth: 1,
    borderColor: '#D0D0D0',
    borderRadius: 20,
    paddingVertical: 8,
    paddingHorizontal: 16,
  },
  optionSelected: { backgroundColor: '#1B6EF3', borderColor: '#1B6EF3' },
  optionText: { fontSize: 15, color: '#333' },
  optionTextSelected: { color: '#fff', fontWeight: '600' },
  minorNotice: {
    backgroundColor: '#EAF2FF',
    borderColor: '#1B6EF3',
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    marginTop: 4,
  },
  minorNoticeText: { color: '#12448F', fontSize: 13, lineHeight: 19 },
  error: { color: '#C4342B', fontSize: 14, marginTop: 4 },
  actions: { flexDirection: 'row', gap: 12, marginTop: 20 },
  button: { flex: 1, borderRadius: 8, paddingVertical: 14, alignItems: 'center' },
  buttonDisabled: { opacity: 0.6 },
  cancel: { borderWidth: 1, borderColor: '#D0D0D0' },
  cancelText: { fontSize: 16, color: '#333' },
  save: { backgroundColor: '#1B6EF3' },
  saveText: { fontSize: 16, color: '#fff', fontWeight: '600' },
});
