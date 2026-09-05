import React, { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { acknowledgeReminder, listActiveBanners, type Reminder } from '../lib/reminders';
import { isSupabaseConfigured } from '../lib/supabase';

/**
 * F2's one-month channel: a persistent in-app banner.
 *
 * Persistent means exactly that — the acknowledgement is stored server-side, so
 * dismissing it on one device dismisses it everywhere, and *not* dismissing it
 * means it is still there on the next open. A toast would be missable once and
 * then gone, which is the failure this channel exists to prevent.
 */
export default function ExpiryBanner({
  documentNames,
}: {
  /** Optional map of document id to a human label, for better wording. */
  documentNames?: Record<string, string>;
}) {
  const [banners, setBanners] = useState<Reminder[]>([]);

  const refresh = useCallback(async () => {
    if (!isSupabaseConfigured) return;
    try {
      setBanners(await listActiveBanners());
    } catch {
      // A banner that cannot load must not take the screen down with it.
      setBanners([]);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh])
  );

  if (banners.length === 0) return null;

  async function dismiss(reminder: Reminder) {
    // Optimistic: the banner has been seen, which is what acknowledgement means.
    setBanners((cur) => cur.filter((b) => b.id !== reminder.id));
    try {
      await acknowledgeReminder(reminder.id);
    } catch {
      void refresh();
    }
  }

  return (
    <View style={styles.wrap}>
      {banners.map((b) => (
        <View key={b.id} style={styles.banner}>
          <View style={styles.textCol}>
            <Text style={styles.title}>Expiring within a month</Text>
            <Text style={styles.body}>
              {documentNames?.[b.ref_id] ?? 'A document'} needs renewing. Renewals can take
              several weeks.
            </Text>
          </View>
          <Pressable onPress={() => dismiss(b)} hitSlop={10} style={styles.dismiss}>
            <Text style={styles.dismissText}>Got it</Text>
          </Pressable>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 8 },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: '#FDECEA',
    borderColor: '#C4342B',
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
  },
  textCol: { flex: 1, gap: 2 },
  title: { fontWeight: '700', color: '#8A241D' },
  body: { color: '#8A241D', fontSize: 13, lineHeight: 18 },
  dismiss: {
    borderWidth: 1,
    borderColor: '#C4342B',
    borderRadius: 6,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  dismissText: { color: '#8A241D', fontWeight: '600', fontSize: 13 },
});
