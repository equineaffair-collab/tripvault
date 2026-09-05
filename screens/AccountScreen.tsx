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
import { useAuth } from '../contexts/AuthContext';
import { getNotificationPreferences, setPushEnabled } from '../lib/reminders';
import {
  FEATURE_LABELS,
  GATED_FEATURES,
  TIER_LABELS,
  TIER_LIMITS,
  TIER_PRICING,
  currentEntitlementProvider,
  getAccountUsage,
  hasFeature,
  type AccountUsage,
} from '../lib/subscription';
import {
  ReauthenticationRequired,
  deleteAccount,
  describeExport,
  exportAccountData,
  type ExportPackage,
} from '../lib/account';

/**
 * F12 — export your data, or delete the account.
 *
 * The two are deliberately separated on the page, and neither is confusable
 * with cancelling a subscription: F12 is explicit that the interface must not
 * imply one action does the other.
 */
export default function AccountScreen({ onBack }: { onBack: () => void }) {
  const { user, signIn, signOut } = useAuth();
  const [busy, setBusy] = useState<'export' | 'delete' | null>(null);
  const [pkg, setPkg] = useState<ExportPackage | null>(null);
  const [password, setPassword] = useState('');
  const [needsReauth, setNeedsReauth] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [pushOn, setPushOn] = useState(true);
  const [usage, setUsage] = useState<AccountUsage | null>(null);

  React.useEffect(() => {
    getAccountUsage()
      .then(setUsage)
      .catch(() => undefined);
  }, []);

  React.useEffect(() => {
    getNotificationPreferences()
      .then((p) => setPushOn(p?.push_enabled ?? true))
      .catch(() => undefined);
  }, []);

  async function runExport() {
    setBusy('export');
    try {
      const result = await exportAccountData();
      setPkg(result);
      setNeedsReauth(false);
    } catch (e) {
      if (e instanceof ReauthenticationRequired) {
        // Not an error to apologise for — it is the control working.
        setNeedsReauth(true);
      } else {
        Alert.alert('Could not export', e instanceof Error ? e.message : String(e));
      }
    } finally {
      setBusy(null);
    }
  }

  async function reauthenticateAndExport() {
    if (!user?.email || !password) return;
    setBusy('export');
    const { error } = await signIn(user.email, password);
    setBusy(null);
    if (error) {
      Alert.alert('Could not log in', error);
      return;
    }
    setPassword('');
    await runExport();
  }

  function confirmDelete() {
    if (confirmText !== 'DELETE') {
      Alert.alert('Type DELETE to confirm', 'This cannot be undone, so we ask you to type it.');
      return;
    }
    Alert.alert(
      'Delete everything?',
      'Your travelers, documents, trips, bookings and loyalty programs will be permanently removed. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete my account',
          style: 'destructive',
          onPress: async () => {
            setBusy('delete');
            try {
              await deleteAccount();
              await signOut();
            } catch (e) {
              Alert.alert('Could not delete', e instanceof Error ? e.message : String(e));
            } finally {
              setBusy(null);
            }
          },
        },
      ]
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
      <Pressable onPress={onBack} hitSlop={8}>
        <Text style={styles.back}>‹ Profile</Text>
      </Pressable>

      <Text style={styles.heading}>Your data</Text>

      {/* ---- Export ---- */}
      <View style={styles.block}>
        <Text style={styles.blockTitle}>Export my data</Text>
        <Text style={styles.body}>
          Everything TripVault holds for you — traveler profiles, documents, trips, bookings and
          loyalty programs — in one readable file. Document numbers are included in the clear,
          because it's your own record.
        </Text>

        {needsReauth ? (
          <View style={styles.reauthBox}>
            <Text style={styles.reauthTitle}>Confirm it's you</Text>
            <Text style={styles.body}>
              An export is a full copy of your most sensitive data, so we ask for your password
              again first.
            </Text>
            <TextInput
              style={styles.input}
              value={password}
              onChangeText={setPassword}
              placeholder="Your password"
              secureTextEntry
              autoCapitalize="none"
              editable={busy === null}
            />
            <Pressable
              style={[styles.primary, busy !== null && styles.disabled]}
              onPress={reauthenticateAndExport}
              disabled={busy !== null}
            >
              {busy === 'export' ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.primaryText}>Confirm and export</Text>
              )}
            </Pressable>
          </View>
        ) : (
          <Pressable
            style={[styles.primary, busy !== null && styles.disabled]}
            onPress={runExport}
            disabled={busy !== null}
          >
            {busy === 'export' ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.primaryText}>Export my data</Text>
            )}
          </Pressable>
        )}

        {pkg && (
          <View style={styles.exportBox}>
            <Text style={styles.exportTitle}>Export ready</Text>
            <Text style={styles.body}>{describeExport(pkg) || 'No data stored yet.'}</Text>
            <Text style={styles.hint}>
              Saving this to a file needs expo-file-system and expo-sharing, which aren't
              dependencies yet. Until then the full package is shown below and can be selected
              and copied.
            </Text>
            <ScrollView style={styles.jsonBox} nestedScrollEnabled>
              <Text selectable style={styles.json}>
                {JSON.stringify(pkg, null, 2)}
              </Text>
            </ScrollView>
          </View>
        )}
      </View>

      {/* ---- Plan (F8) ---- */}
      {usage && (
        <View style={styles.block}>
          <Text style={styles.blockTitle}>Your plan: {TIER_LABELS[usage.tier]}</Text>
          <Text style={styles.body}>{TIER_PRICING[usage.tier]}</Text>

          <Text style={styles.usageLine}>
            Traveler profiles: {usage.travelers} of {TIER_LIMITS[usage.tier].travelerProfiles}
          </Text>
          <Text style={styles.usageLine}>
            Active trips: {usage.activeTrips} of{' '}
            {TIER_LIMITS[usage.tier].activeTrips ?? 'unlimited'}
          </Text>

          {GATED_FEATURES.map((f) => (
            <Text key={f} style={styles.usageLine}>
              {hasFeature(usage.tier, f) ? '✓' : '·'} {FEATURE_LABELS[f]}
              {hasFeature(usage.tier, f) ? '' : ' — not on this plan'}
            </Text>
          ))}

          {!currentEntitlementProvider().canPurchase && (
            <Text style={styles.hint}>
              Upgrading isn't available yet — RevenueCat isn't connected, so there's no way to
              buy a plan from inside the app. The limits above are already enforced.
            </Text>
          )}
        </View>
      )}

      {/* ---- Notifications (F2) ---- */}
      <View style={styles.block}>
        <Text style={styles.blockTitle}>Expiry reminders</Text>
        <Text style={styles.body}>
          TripVault warns you six months, three months and one month before a document expires.
        </Text>

        <Pressable
          style={styles.toggleRow}
          onPress={async () => {
            const next = !pushOn;
            setPushOn(next);
            try {
              await setPushEnabled(next);
            } catch (e) {
              setPushOn(!next);
              Alert.alert('Could not save', e instanceof Error ? e.message : String(e));
            }
          }}
        >
          <View style={[styles.checkbox, pushOn && styles.checkboxOn]}>
            {pushOn && <Text style={styles.tick}>✓</Text>}
          </View>
          <View style={styles.toggleText}>
            <Text style={styles.toggleLabel}>Push notifications</Text>
            <Text style={styles.hint}>
              A convenience layer on top of email. Turning this off is fine.
            </Text>
          </View>
        </Pressable>

        <View style={styles.lockedRow}>
          <View style={[styles.checkbox, styles.checkboxLocked]}>
            <Text style={styles.tick}>✓</Text>
          </View>
          <View style={styles.toggleText}>
            <Text style={styles.toggleLabel}>Email reminders — always on</Text>
            <Text style={styles.hint}>
              Email can't be switched off. It's the channel that survives a lost phone or a
              declined notification permission, and silencing everything would mean TripVault
              quietly stops doing the one thing it's for.
            </Text>
          </View>
        </View>
      </View>

      {/* ---- Deletion ---- */}
      <View style={[styles.block, styles.dangerBlock]}>
        <Text style={styles.blockTitleDanger}>Delete my account</Text>
        <Text style={styles.body}>
          Permanently removes your account and everything in it. This cannot be undone.
        </Text>
        <Text style={styles.hint}>
          This is not the same as cancelling a subscription — deleting your account does not
          cancel a subscription, and cancelling a subscription does not delete your data.
        </Text>

        <TextInput
          style={styles.input}
          value={confirmText}
          onChangeText={setConfirmText}
          placeholder="Type DELETE to confirm"
          autoCapitalize="characters"
          autoCorrect={false}
          editable={busy === null}
        />

        <Pressable
          style={[styles.danger, (busy !== null || confirmText !== 'DELETE') && styles.disabled]}
          onPress={confirmDelete}
          disabled={busy !== null || confirmText !== 'DELETE'}
        >
          {busy === 'delete' ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.primaryText}>Delete my account</Text>
          )}
        </Pressable>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { padding: 24, gap: 16, paddingBottom: 48 },
  back: { color: '#1B6EF3', fontSize: 15, fontWeight: '600' },
  heading: { fontSize: 22, fontWeight: '700' },
  block: {
    borderWidth: 1,
    borderColor: '#E4E4E4',
    borderRadius: 10,
    padding: 16,
    gap: 10,
  },
  dangerBlock: { borderColor: '#E8B4B0', backgroundColor: '#FFF8F8' },
  blockTitle: { fontSize: 17, fontWeight: '700' },
  blockTitleDanger: { fontSize: 17, fontWeight: '700', color: '#A32B22' },
  body: { fontSize: 14, color: '#444', lineHeight: 20 },
  hint: { fontSize: 13, color: '#666', lineHeight: 19, fontStyle: 'italic' },
  input: {
    borderWidth: 1,
    borderColor: '#D0D0D0',
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    backgroundColor: '#fff',
  },
  reauthBox: {
    backgroundColor: '#EAF2FF',
    borderColor: '#1B6EF3',
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    gap: 8,
  },
  reauthTitle: { fontWeight: '700', color: '#0B3E8F' },
  exportBox: {
    backgroundColor: '#EDF7ED',
    borderColor: '#3F8E3F',
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    gap: 8,
  },
  exportTitle: { fontWeight: '700', color: '#215821' },
  jsonBox: {
    maxHeight: 240,
    backgroundColor: '#fff',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#CFE3CF',
    padding: 8,
  },
  json: { fontSize: 11, fontFamily: 'monospace', color: '#333' },
  primary: {
    backgroundColor: '#1B6EF3',
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: 'center',
  },
  danger: {
    backgroundColor: '#C4342B',
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: 'center',
  },
  disabled: { opacity: 0.45 },
  primaryText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  toggleRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, marginTop: 4 },
  lockedRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, marginTop: 4, opacity: 0.85 },
  checkbox: { width: 24, height: 24, borderRadius: 5, borderWidth: 1, borderColor: '#9A9A9A', alignItems: 'center', justifyContent: 'center', marginTop: 2 },
  checkboxOn: { backgroundColor: '#1B6EF3', borderColor: '#1B6EF3' },
  checkboxLocked: { backgroundColor: '#9A9A9A', borderColor: '#9A9A9A' },
  tick: { color: '#fff', fontSize: 15, fontWeight: '700' },
  toggleText: { flex: 1, gap: 2 },
  toggleLabel: { fontSize: 15, fontWeight: '500' },
  usageLine: { fontSize: 14, color: '#444', lineHeight: 21 },
});
