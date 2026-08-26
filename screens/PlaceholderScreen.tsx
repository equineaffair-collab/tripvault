import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

/**
 * Phase 0 tab body. Each tab gets its real screen in a later phase:
 * Documents -> F1 (Phase 2), Trips -> F3 (Phase 5), Profile -> F11 (Phase 1).
 */
export default function PlaceholderScreen({
  title,
  comingIn,
}: {
  title: string;
  comingIn: string;
}) {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.body}>Nothing here yet — this arrives in {comingIn}.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 8 },
  title: { fontSize: 22, fontWeight: '600' },
  body: { fontSize: 15, color: '#666', textAlign: 'center' },
});
