import React, { useCallback, useState } from 'react';
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
import { useFocusEffect } from '@react-navigation/native';
import { isSupabaseConfigured } from '../lib/supabase';
import { listTravelers } from '../lib/travelers';
import type { Traveler } from '../types/traveler';
import {
  createTrip,
  deleteTrip,
  listTrips,
  listTripAttendeeIds,
  setTripAttendees,
  updateTrip,
  type Trip,
} from '../lib/trips';
import TripDetailScreen from './TripDetailScreen';

type Mode =
  | { kind: 'list' }
  | { kind: 'form'; existing: Trip | null }
  | { kind: 'detail'; trip: Trip };

export default function TripsScreen() {
  const [trips, setTrips] = useState<Trip[]>([]);
  const [travelers, setTravelers] = useState<Traveler[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>({ kind: 'list' });

  const refresh = useCallback(async () => {
    if (!isSupabaseConfigured) {
      setLoading(false);
      setError('Supabase is not configured yet — add your keys to .env.');
      return;
    }
    setLoading(true);
    try {
      const [t, p] = await Promise.all([listTrips(), listTravelers()]);
      setTrips(t);
      setTravelers(p);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  // On focus, so a traveler added on the Profile tab is selectable here without
  // restarting the app — the same trap that bit the Documents screen.
  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh])
  );

  if (mode.kind === 'detail') {
    return (
      <TripDetailScreen
        trip={mode.trip}
        travelers={travelers}
        onBack={() => {
          setMode({ kind: 'list' });
          void refresh();
        }}
      />
    );
  }

  if (mode.kind === 'form') {
    return (
      <TripForm
        existing={mode.existing}
        travelers={travelers}
        onCancel={() => setMode({ kind: 'list' })}
        onSaved={(trip) => {
          void refresh();
          setMode({ kind: 'detail', trip });
        }}
      />
    );
  }

  function confirmDelete(trip: Trip) {
    Alert.alert('Delete trip', `Delete "${trip.name}" and everything in it?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            await deleteTrip(trip.id);
            await refresh();
          } catch (e) {
            Alert.alert('Could not delete', e instanceof Error ? e.message : String(e));
          }
        },
      },
    ]);
  }

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.heading}>Trips</Text>
        {error && <Text style={styles.error}>{error}</Text>}
        {loading && <ActivityIndicator style={styles.spinner} />}

        {!loading && trips.length === 0 && !error && (
          <Text style={styles.empty}>
            No trips yet. Create one and TripVault will check everyone's passports against the
            dates.
          </Text>
        )}

        {trips.map((trip) => (
          <Pressable
            key={trip.id}
            style={styles.card}
            onPress={() => setMode({ kind: 'detail', trip })}
            onLongPress={() => confirmDelete(trip)}
          >
            <Text style={styles.cardTitle}>{trip.name}</Text>
            <Text style={styles.cardMeta}>
              {trip.destination ? `${trip.destination} · ` : ''}
              {formatRange(trip.start_date, trip.end_date)}
            </Text>
          </Pressable>
        ))}
      </ScrollView>

      <Pressable style={styles.primary} onPress={() => setMode({ kind: 'form', existing: null })}>
        <Text style={styles.primaryText}>New trip</Text>
      </Pressable>
    </View>
  );
}

function formatRange(start: string | null, end: string | null): string {
  if (!start && !end) return 'Dates not set';
  if (start && end) return `${start} → ${end}`;
  return start ? `From ${start}` : `Until ${end}`;
}

function TripForm({
  existing,
  travelers,
  onSaved,
  onCancel,
}: {
  existing: Trip | null;
  travelers: Traveler[];
  onSaved: (trip: Trip) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(existing?.name ?? '');
  const [destination, setDestination] = useState(existing?.destination ?? '');
  const [startDate, setStartDate] = useState(existing?.start_date ?? '');
  const [endDate, setEndDate] = useState(existing?.end_date ?? '');
  const [attendees, setAttendees] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [loadedAttendees, setLoadedAttendees] = useState(!existing);

  // Existing trips need their current attendee list before the form is useful.
  React.useEffect(() => {
    if (!existing) return;
    let active = true;
    listTripAttendeeIds(existing.id)
      .then((ids) => {
        if (active) setAttendees(ids);
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) setLoadedAttendees(true);
      });
    return () => {
      active = false;
    };
  }, [existing]);

  const dateOk = (v: string) => v === '' || /^\d{4}-\d{2}-\d{2}$/.test(v);

  async function save() {
    if (!name.trim()) {
      Alert.alert('Name required', 'Give the trip a name.');
      return;
    }
    if (!dateOk(startDate) || !dateOk(endDate)) {
      Alert.alert('Check the dates', 'Use the format YYYY-MM-DD.');
      return;
    }
    if (startDate && endDate && startDate > endDate) {
      Alert.alert('Check the dates', 'The trip ends before it starts.');
      return;
    }

    setBusy(true);
    try {
      const input = { name, destination, startDate, endDate };
      if (existing) {
        const trip = await updateTrip(existing.id, input);
        await setTripAttendees(existing.id, attendees);
        onSaved(trip);
      } else {
        onSaved(await createTrip(input, attendees));
      }
    } catch (e) {
      Alert.alert('Could not save', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
      <Text style={styles.heading}>{existing ? 'Edit trip' : 'New trip'}</Text>

      <Text style={styles.label}>Name</Text>
      <TextInput
        style={styles.input}
        value={name}
        onChangeText={setName}
        placeholder="e.g. Japan, spring"
        editable={!busy}
      />

      <Text style={styles.label}>Destination</Text>
      <TextInput
        style={styles.input}
        value={destination}
        onChangeText={setDestination}
        placeholder="e.g. Tokyo"
        editable={!busy}
      />

      <Text style={styles.label}>Start date (YYYY-MM-DD)</Text>
      <TextInput
        style={styles.input}
        value={startDate}
        onChangeText={setStartDate}
        placeholder="2027-04-01"
        autoCorrect={false}
        editable={!busy}
      />

      <Text style={styles.label}>End date (YYYY-MM-DD)</Text>
      <TextInput
        style={styles.input}
        value={endDate}
        onChangeText={setEndDate}
        placeholder="2027-04-14"
        autoCorrect={false}
        editable={!busy}
      />

      <Text style={styles.label}>Who's going</Text>
      {travelers.length === 0 ? (
        <Text style={styles.hint}>
          No traveler profiles yet — add them on the Profile tab and they'll be selectable here.
        </Text>
      ) : !loadedAttendees ? (
        <ActivityIndicator style={styles.spinner} />
      ) : (
        <View style={styles.chips}>
          {travelers.map((t) => {
            const on = attendees.includes(t.id);
            return (
              <Pressable
                key={t.id}
                style={[styles.chip, on && styles.chipOn]}
                onPress={() =>
                  setAttendees((cur) =>
                    cur.includes(t.id) ? cur.filter((x) => x !== t.id) : [...cur, t.id]
                  )
                }
                disabled={busy}
              >
                <Text style={[styles.chipText, on && styles.chipTextOn]}>{t.name}</Text>
              </Pressable>
            );
          })}
        </View>
      )}

      <Text style={styles.hint}>
        On save, TripVault checks each attendee's passport against the end date for the usual
        six-month rule.
      </Text>

      <Pressable style={[styles.primaryInline, busy && styles.disabled]} onPress={save} disabled={busy}>
        {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryText}>Save trip</Text>}
      </Pressable>

      <Pressable onPress={onCancel} disabled={busy} hitSlop={8}>
        <Text style={styles.cancel}>Cancel</Text>
      </Pressable>
    </ScrollView>
  );
}

export const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  scroll: { padding: 24, gap: 12, paddingBottom: 40 },
  heading: { fontSize: 22, fontWeight: '700' },
  error: { color: '#C4342B', fontSize: 14 },
  empty: { color: '#666', fontSize: 15, lineHeight: 21 },
  hint: { color: '#666', fontSize: 13, lineHeight: 19 },
  spinner: { marginTop: 12 },
  card: {
    borderWidth: 1,
    borderColor: '#E4E4E4',
    borderRadius: 10,
    padding: 14,
    gap: 4,
    marginTop: 4,
  },
  cardTitle: { fontSize: 17, fontWeight: '600' },
  cardMeta: { fontSize: 14, color: '#666' },
  label: {
    fontSize: 13,
    color: '#666',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: 8,
  },
  input: {
    borderWidth: 1,
    borderColor: '#D0D0D0',
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
  },
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
  primary: {
    backgroundColor: '#1B6EF3',
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: 'center',
    margin: 24,
    marginTop: 8,
  },
  primaryInline: {
    backgroundColor: '#1B6EF3',
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 8,
  },
  disabled: { opacity: 0.6 },
  primaryText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  cancel: { textAlign: 'center', color: '#1B6EF3', marginTop: 4 },
});
