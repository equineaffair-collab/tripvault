import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

/**
 * F1's parent/guardian gate, shown once per minor profile at the point their
 * first document is entered -- deliberately here rather than buried in account
 * signup, so the confirmation is attached to the specific child whose passport
 * is about to be stored.
 *
 * The server refuses the write until this is confirmed and records when it was,
 * so this screen is the prompt, not the enforcement. See the Edge Function.
 */
export default function GuardianAcknowledgement({
  travelerName,
  onConfirm,
  onCancel,
}: {
  travelerName: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [checked, setChecked] = useState(false);

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.heading}>Before you add {travelerName}'s document</Text>

      <Text style={styles.body}>
        You've marked {travelerName} as a child. Storing a child's passport or ID carries
        obligations TripVault takes seriously, so we ask you to confirm this once for this
        profile.
      </Text>

      <View style={styles.points}>
        <Point>
          TripVault stores only what it needs for a child: document type, number, issuing
          country and expiry date. Optional details are skipped.
        </Point>
        <Point>
          The document number is encrypted, and the scan is readable only by you.
        </Point>
        <Point>
          You can delete {travelerName}'s profile and every document attached to it at any
          time, from their profile.
        </Point>
      </View>

      <Pressable style={styles.checkRow} onPress={() => setChecked((v) => !v)}>
        <View style={[styles.checkbox, checked && styles.checkboxOn]}>
          {checked && <Text style={styles.tick}>✓</Text>}
        </View>
        <Text style={styles.checkLabel}>
          I confirm I am {travelerName}'s parent or legal guardian, and I'm entering these
          details on their behalf.
        </Text>
      </Pressable>

      <Pressable
        style={[styles.confirm, !checked && styles.disabled]}
        onPress={onConfirm}
        disabled={!checked}
      >
        <Text style={styles.confirmText}>Confirm and continue</Text>
      </Pressable>

      <Pressable onPress={onCancel} hitSlop={8}>
        <Text style={styles.cancel}>Not now</Text>
      </Pressable>
    </ScrollView>
  );
}

function Point({ children }: { children: React.ReactNode }) {
  return (
    <View style={styles.point}>
      <Text style={styles.bullet}>•</Text>
      <Text style={styles.pointText}>{children}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { padding: 24, gap: 18, paddingBottom: 48 },
  heading: { fontSize: 22, fontWeight: '700', lineHeight: 29 },
  body: { fontSize: 15, color: '#333', lineHeight: 22 },
  points: { gap: 10, backgroundColor: '#F6F7F9', borderRadius: 8, padding: 14 },
  point: { flexDirection: 'row', gap: 8 },
  bullet: { color: '#666', fontSize: 15, lineHeight: 21 },
  pointText: { flex: 1, fontSize: 14, color: '#444', lineHeight: 21 },
  checkRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  checkbox: {
    width: 26,
    height: 26,
    borderRadius: 5,
    borderWidth: 1,
    borderColor: '#9A9A9A',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  checkboxOn: { backgroundColor: '#1B6EF3', borderColor: '#1B6EF3' },
  tick: { color: '#fff', fontSize: 16, fontWeight: '700' },
  checkLabel: { flex: 1, fontSize: 15, lineHeight: 22, color: '#111' },
  confirm: {
    backgroundColor: '#1B6EF3',
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: 'center',
  },
  disabled: { opacity: 0.45 },
  confirmText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  cancel: { textAlign: 'center', color: '#1B6EF3', paddingVertical: 4 },
});
