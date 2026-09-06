/**
 * F5 — the forwarding address, what has arrived, and the holding area.
 *
 * All three on one screen because they are one story told in order: here is the
 * address, here is what came through it, here is what still needs filing. Split
 * across tabs, the middle step disappears and a forwarded email that failed
 * becomes invisible — which is the failure mode this whole path has.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  FORWARDING_ADDRESS_NOTE,
  HOLDING_AREA_NOTE,
  SmartImportNotIncluded,
  TRIP_ITEM_LABELS,
  assignToTrip,
  deleteInboundEmail,
  describeInbound,
  discardHoldingItem,
  forwardingAddress,
  getForwardingAddress,
  holdingAreaSummary,
  listHoldingArea,
  listInboundEmails,
  listTripWindows,
  rotateForwardingAddress,
  suggestTrip,
  type ForwardingAddress,
  type HoldingItem,
  type InboundEmail,
  type TripItemType,
  type TripWindow,
} from '../lib/smartImport';

type Props = { onBack: () => void };

export default function SmartImportScreen({ onBack }: Props) {
  const [address, setAddress] = useState<ForwardingAddress | null>(null);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [inbox, setInbox] = useState<InboundEmail[]>([]);
  const [holding, setHolding] = useState<HoldingItem[]>([]);
  const [trips, setTrips] = useState<TripWindow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      // The holding area and the receipts are ordinary tables, so they load
      // even when the feature is not included — a lapsed plan should not hide
      // bookings that already exist.
      const [emails, items, windows] = await Promise.all([
        listInboundEmails(),
        listHoldingArea(),
        listTripWindows(),
      ]);
      setInbox(emails);
      setHolding(items);
      setTrips(windows);

      try {
        setAddress(await getForwardingAddress());
        setBlocked(null);
      } catch (e) {
        if (e instanceof SmartImportNotIncluded) setBlocked(e.message);
        else throw e;
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load smart import.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  function confirmRotate() {
    Alert.alert(
      'Replace this address?',
      'The current address stops working straight away. Anything forwarded to it after that ' +
        'is lost, so update it anywhere you have saved it.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Replace',
          style: 'destructive',
          onPress: async () => {
            try {
              setAddress(await rotateForwardingAddress());
            } catch (e) {
              Alert.alert('Could not replace', e instanceof Error ? e.message : 'Unknown error');
            }
          },
        },
      ]
    );
  }

  function fileItem(item: HoldingItem) {
    if (trips.length === 0) {
      Alert.alert('No trips yet', 'Create a trip first, then this can be filed against it.');
      return;
    }

    const suggestion = suggestTrip(item.itemDate, trips);
    // The suggestion is offered first and still has to be tapped. Filing
    // silently would put a booking somewhere nobody goes looking for it.
    const ordered = suggestion
      ? [
          ...trips.filter((t) => t.id === suggestion.tripId),
          ...trips.filter((t) => t.id !== suggestion.tripId),
        ]
      : trips;

    Alert.alert(
      'Which trip?',
      suggestion ? suggestion.reason : 'Pick the trip this booking belongs to.',
      [
        ...ordered.slice(0, 3).map((trip) => ({
          text: trip.id === suggestion?.tripId ? `${trip.name} (suggested)` : trip.name,
          onPress: async () => {
            try {
              await assignToTrip(item.id, trip.id);
              await refresh();
            } catch (e) {
              Alert.alert('Could not file it', e instanceof Error ? e.message : 'Unknown error');
            }
          },
        })),
        { text: 'Cancel', style: 'cancel' as const },
      ]
    );
  }

  function confirmDiscard(item: HoldingItem) {
    Alert.alert('Discard this booking?', 'It will be deleted.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Discard',
        style: 'destructive',
        onPress: async () => {
          await discardHoldingItem(item.id);
          await refresh();
        },
      },
    ]);
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Pressable onPress={onBack} hitSlop={12}>
        <Text style={styles.back}>‹ Back</Text>
      </Pressable>

      <Text style={styles.title}>Smart import</Text>
      <Text style={styles.lede}>
        Forward a booking confirmation from your normal email app and it turns into a booking
        here, ready to file against a trip.
      </Text>

      {error && <Text style={styles.error}>{error}</Text>}
      {loading && <ActivityIndicator style={styles.spinner} />}

      {blocked ? (
        <View style={styles.blockedBox}>
          <Text style={styles.blockedText}>{blocked}</Text>
        </View>
      ) : address ? (
        <View style={styles.addressBox}>
          <Text style={styles.addressLabel}>Your forwarding address</Text>
          {address.configured ? (
            <>
              <Text selectable style={styles.address}>
                {forwardingAddress(address.localPart, address.domain)}
              </Text>
              <Text style={styles.addressNote}>{FORWARDING_ADDRESS_NOTE}</Text>
              <Pressable onPress={confirmRotate} hitSlop={8}>
                <Text style={styles.rotate}>Replace this address</Text>
              </Pressable>
            </>
          ) : (
            <Text style={styles.addressNote}>
              Your address is reserved, but the mail domain that receives it is not set up yet, so
              there is nothing to forward to for now. Bookings can still be added by hand.
            </Text>
          )}
        </View>
      ) : null}

      <Text style={styles.sectionTitle}>Recently forwarded</Text>
      {inbox.length === 0 ? (
        <Text style={styles.empty}>Nothing forwarded yet.</Text>
      ) : (
        inbox.map((mail) => (
          <View key={mail.id} style={styles.mailRow}>
            <View style={styles.mailMain}>
              <Text style={styles.mailSubject}>{mail.subject ?? '(no subject)'}</Text>
              <Text style={styles.mailMeta}>{describeInbound(mail.status, mail.detail)}</Text>
            </View>
            <Pressable
              onPress={async () => {
                await deleteInboundEmail(mail.id);
                await refresh();
              }}
              hitSlop={8}
            >
              <Text style={styles.remove}>Delete</Text>
            </Pressable>
          </View>
        ))
      )}

      <Text style={styles.sectionTitle}>Needs a trip</Text>
      <Text style={styles.empty}>{holdingAreaSummary(holding.length)}</Text>
      {holding.length > 0 && <Text style={styles.holdingNote}>{HOLDING_AREA_NOTE}</Text>}

      {holding.map((item) => (
        <View key={item.id} style={styles.itemRow}>
          <View style={styles.mailMain}>
            <Text style={styles.itemTitle}>
              {TRIP_ITEM_LABELS[item.type as TripItemType] ?? 'Booking'}
              {item.provider ? ` — ${item.provider}` : ''}
            </Text>
            <Text style={styles.mailMeta}>
              {[item.itemDate?.slice(0, 10), item.confirmationNumber]
                .filter(Boolean)
                .join(' · ') || 'No date or reference'}
            </Text>
          </View>
          <Pressable onPress={() => fileItem(item)} hitSlop={8}>
            <Text style={styles.file}>File ›</Text>
          </Pressable>
          <Pressable onPress={() => confirmDiscard(item)} hitSlop={8} style={styles.discard}>
            <Text style={styles.remove}>Discard</Text>
          </Pressable>
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  content: { padding: 20, paddingBottom: 48 },
  back: { color: '#1B6EF3', fontSize: 16, marginBottom: 12 },
  title: { fontSize: 22, fontWeight: '700', marginBottom: 6 },
  lede: { fontSize: 15, color: '#444', lineHeight: 21, marginBottom: 18 },
  spinner: { marginVertical: 16 },
  blockedBox: {
    backgroundColor: '#FFF6E5',
    borderLeftWidth: 3,
    borderLeftColor: '#C98A2B',
    padding: 12,
    borderRadius: 6,
  },
  blockedText: { fontSize: 14, color: '#5A431A', lineHeight: 20 },
  addressBox: { backgroundColor: '#EAF2FE', borderRadius: 10, padding: 14 },
  addressLabel: { fontSize: 12, fontWeight: '700', color: '#1B4E8F', textTransform: 'uppercase' },
  address: { fontSize: 15, fontFamily: 'monospace', marginVertical: 10, color: '#12233A' },
  addressNote: { fontSize: 13, color: '#3C4A5A', lineHeight: 19, marginTop: 8 },
  rotate: { color: '#1B6EF3', fontSize: 14, fontWeight: '600', marginTop: 12 },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '700',
    textTransform: 'uppercase',
    color: '#555',
    marginTop: 28,
    marginBottom: 8,
  },
  empty: { fontSize: 14, color: '#777' },
  holdingNote: { fontSize: 13, color: '#666', lineHeight: 19, marginTop: 6, marginBottom: 6 },
  mailRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#E2E6EA',
  },
  itemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#E2E6EA',
  },
  mailMain: { flex: 1, paddingRight: 10 },
  mailSubject: { fontSize: 15, fontWeight: '600', color: '#1a1a1a' },
  itemTitle: { fontSize: 15, fontWeight: '600', color: '#1a1a1a' },
  mailMeta: { fontSize: 13, color: '#666', marginTop: 3, lineHeight: 18 },
  file: { color: '#1B6EF3', fontSize: 14, fontWeight: '600' },
  discard: { marginLeft: 14 },
  remove: { color: '#777', fontSize: 13 },
  error: { color: '#C0392B', marginBottom: 12 },
});
