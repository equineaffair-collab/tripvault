/**
 * F9 mechanism 1 — the recipient's one-time step.
 *
 * They sign up for TripVault normally first: a linked family member is a
 * genuine account holder in their own right, with their own terms acceptance,
 * not a guest riding on someone else's login. Then they enter the code once,
 * ever, and the app switches to their own read-only view.
 */
import React, { useState } from 'react';
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { acceptInvite } from '../lib/familyAccess';

type Props = {
  onBack: () => void;
  /** Called once a code is accepted, so the app can re-resolve who this is. */
  onAccepted: () => void;
};

export default function AcceptInviteScreen({ onBack, onAccepted }: Props) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit() {
    setBusy(true);
    setError(null);
    try {
      const { travelerName } = await acceptInvite(code);
      Alert.alert(
        'You’re in',
        `You now have your own access as ${travelerName}. Trips you are added to will appear here.`,
        [{ text: 'OK', onPress: onAccepted }]
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not use that code.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Pressable onPress={onBack} hitSlop={12}>
        <Text style={styles.back}>‹ Back</Text>
      </Pressable>

      <Text style={styles.title}>Enter an invite code</Text>
      <Text style={styles.lede}>
        If someone organizes travel for you and has given you a code, enter it here. You will see
        the trips they add you to, and your own documents — nothing else in their account.
      </Text>

      <TextInput
        style={styles.input}
        value={code}
        onChangeText={setCode}
        placeholder="Paste the code"
        autoCapitalize="none"
        autoCorrect={false}
        multiline
      />

      {error && <Text style={styles.error}>{error}</Text>}

      <Pressable
        style={[styles.primaryButton, (busy || !code.trim()) && styles.buttonDisabled]}
        onPress={handleSubmit}
        disabled={busy || !code.trim()}
      >
        <Text style={styles.primaryButtonText}>{busy ? 'Checking…' : 'Use this code'}</Text>
      </Pressable>

      <View style={styles.noteBox}>
        <Text style={styles.noteText}>
          A code works once and only for the person it was made for. If it has expired, ask for a
          new one — codes cannot be looked up or resent.
        </Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  content: { padding: 20, paddingBottom: 48 },
  back: { color: '#1B6EF3', fontSize: 16, marginBottom: 12 },
  title: { fontSize: 22, fontWeight: '700', marginBottom: 6 },
  lede: { fontSize: 15, color: '#444', lineHeight: 21, marginBottom: 18 },
  input: {
    borderWidth: 1,
    borderColor: '#D5DAE0',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 12,
    fontSize: 15,
    fontFamily: 'monospace',
    minHeight: 72,
    textAlignVertical: 'top',
  },
  primaryButton: {
    backgroundColor: '#1B6EF3',
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 16,
  },
  buttonDisabled: { opacity: 0.5 },
  primaryButtonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  noteBox: { backgroundColor: '#F5F7FA', borderRadius: 8, padding: 12, marginTop: 24 },
  noteText: { fontSize: 13, color: '#555', lineHeight: 19 },
  error: { color: '#C0392B', marginTop: 12 },
});
