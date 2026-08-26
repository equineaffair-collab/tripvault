import React from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { useAuth } from '../contexts/AuthContext';

export default function ProfileScreen() {
  const { user, signOut } = useAuth();

  function confirmSignOut() {
    Alert.alert('Log out', 'Log out of TripVault on this device?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Log out', style: 'destructive', onPress: () => void signOut() },
    ]);
  }

  return (
    <View style={styles.container}>
      <View style={styles.block}>
        <Text style={styles.label}>Logged in as</Text>
        <Text style={styles.value}>{user?.email ?? 'unknown'}</Text>
      </View>

      <Text style={styles.note}>
        Traveler profiles arrive in Phase 1 (F11).
      </Text>

      <Pressable style={styles.button} onPress={confirmSignOut}>
        <Text style={styles.buttonText}>Log out</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 24, gap: 20 },
  block: { gap: 4 },
  label: { fontSize: 13, color: '#666', textTransform: 'uppercase', letterSpacing: 0.5 },
  value: { fontSize: 17, fontWeight: '500' },
  note: { fontSize: 14, color: '#666' },
  button: {
    marginTop: 'auto',
    borderWidth: 1,
    borderColor: '#C4342B',
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: 'center',
  },
  buttonText: { color: '#C4342B', fontSize: 16, fontWeight: '600' },
});
