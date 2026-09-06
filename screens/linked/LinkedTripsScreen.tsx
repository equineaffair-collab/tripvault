/**
 * F9 mechanism 1 — the linked member's own view of their trips.
 *
 * Read-only, and it looks read-only: no add button, no checkboxes, nothing that
 * suggests an action the database would refuse. The scoping is not done here —
 * RLS returns only trips this person attends, and this screen deliberately adds
 * no filter of its own, so if something unexpected ever appears the bug is
 * visibly in the policy rather than hidden by a second belt here.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import {
  getLinkedTrip,
  listLinkedTrips,
  type LinkedTrip,
  type LinkedTripDetail,
} from '../../lib/familyAccess';

const ITEM_LABELS: Record<string, string> = {
  flight: 'Flight',
  accommodation: 'Stay',
  car_hire: 'Car hire',
  transfer: 'Transfer',
  activity: 'Activity',
  other: 'Booking',
};

function dateRange(trip: { startDate: string | null; endDate: string | null }): string {
  const parts = [trip.startDate, trip.endDate].filter(Boolean);
  return parts.length === 2 ? `${parts[0]} – ${parts[1]}` : (parts[0] ?? 'Dates not set');
}

export default function LinkedTripsScreen() {
  const [trips, setTrips] = useState<LinkedTrip[]>([]);
  const [detail, setDetail] = useState<LinkedTripDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      setTrips(await listLinkedTrips());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load your trips.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // The organizer can add this person to a trip at any moment, and the whole
  // promise of the linked login is that it "just appears". Refetching on focus
  // is what makes that true without a pull-to-refresh nobody thinks to try.
  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh])
  );

  async function open(trip: LinkedTrip) {
    setDetail(null);
    setLoading(true);
    try {
      setDetail(await getLinkedTrip(trip.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not open that trip.');
    } finally {
      setLoading(false);
    }
  }

  if (detail) {
    return (
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        <Pressable onPress={() => setDetail(null)} hitSlop={12}>
          <Text style={styles.back}>‹ All trips</Text>
        </Pressable>

        <Text style={styles.title}>{detail.trip.name}</Text>
        {detail.trip.destination && <Text style={styles.sub}>{detail.trip.destination}</Text>}
        <Text style={styles.sub}>{dateRange(detail.trip)}</Text>

        <Text style={styles.sectionTitle}>Bookings</Text>
        {detail.items.length === 0 ? (
          <Text style={styles.empty}>Nothing booked yet.</Text>
        ) : (
          detail.items.map((i) => (
            <View key={String(i.id)} style={styles.card}>
              <Text style={styles.cardTitle}>
                {ITEM_LABELS[String(i.type)] ?? 'Booking'}
                {i.provider ? ` — ${i.provider}` : ''}
              </Text>
              {i.item_date != null && (
                <Text style={styles.cardMeta}>{String(i.item_date).replace('T', ' ').slice(0, 16)}</Text>
              )}
              {i.confirmation_number != null && (
                <Text style={styles.cardMeta}>Ref {String(i.confirmation_number)}</Text>
              )}
              {i.notes != null && <Text style={styles.cardMeta}>{String(i.notes)}</Text>}
            </View>
          ))
        )}

        <Text style={styles.sectionTitle}>Checklist</Text>
        {detail.checklist.length === 0 ? (
          <Text style={styles.empty}>Nothing on the list.</Text>
        ) : (
          detail.checklist.map((c) => (
            <Text
              key={String(c.id)}
              style={[styles.task, c.status === 'done' && styles.taskDone]}
            >
              {c.status === 'done' ? '✓ ' : '• '}
              {String(c.label)}
            </Text>
          ))
        )}

        <Text style={styles.footnote}>
          This is the organizer's list. You can see it, but ticking things off is theirs to do.
        </Text>
      </ScrollView>
    );
  }

  return (
    <View style={styles.container}>
      <FlatList
        data={trips}
        keyExtractor={(t) => t.id}
        contentContainerStyle={styles.content}
        ListHeaderComponent={
          <>
            <Text style={styles.title}>Your trips</Text>
            <Text style={styles.sub}>
              Trips you have been added to. They appear here on their own — nobody has to send
              you anything.
            </Text>
            {error && <Text style={styles.error}>{error}</Text>}
          </>
        }
        ListEmptyComponent={
          loading ? (
            <ActivityIndicator style={styles.spinner} />
          ) : (
            <Text style={styles.empty}>
              No trips yet. When you are added to one, it will show up here.
            </Text>
          )
        }
        renderItem={({ item }) => (
          <Pressable style={styles.row} onPress={() => void open(item)}>
            <Text style={styles.rowName}>{item.name}</Text>
            <Text style={styles.rowMeta}>
              {[item.destination, dateRange(item)].filter(Boolean).join(' · ')}
            </Text>
          </Pressable>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  content: { padding: 20, paddingBottom: 48 },
  back: { color: '#1B6EF3', fontSize: 16, marginBottom: 12 },
  title: { fontSize: 22, fontWeight: '700', marginBottom: 6 },
  sub: { fontSize: 15, color: '#555', lineHeight: 21 },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '700',
    textTransform: 'uppercase',
    color: '#555',
    marginTop: 26,
    marginBottom: 8,
  },
  card: {
    backgroundColor: '#F5F7FA',
    borderRadius: 10,
    padding: 12,
    marginBottom: 10,
  },
  cardTitle: { fontSize: 15, fontWeight: '600', color: '#1a1a1a' },
  cardMeta: { fontSize: 13, color: '#555', marginTop: 4 },
  task: { fontSize: 15, color: '#222', marginBottom: 8 },
  taskDone: { color: '#8A8A8A', textDecorationLine: 'line-through' },
  row: {
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#E2E6EA',
  },
  rowName: { fontSize: 16, fontWeight: '600', color: '#1a1a1a' },
  rowMeta: { fontSize: 13, color: '#666', marginTop: 3 },
  empty: { fontSize: 14, color: '#777', marginTop: 10 },
  spinner: { marginTop: 30 },
  footnote: { fontSize: 13, color: '#777', marginTop: 28, lineHeight: 19 },
  error: { color: '#C0392B', marginTop: 12 },
});
