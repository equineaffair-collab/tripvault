/**
 * F2 — client access to reminders and notification preferences.
 *
 * The sweep creates reminders; the app only reads them and acknowledges the
 * banner. Reminders are deliberately not insertable from here: a client that
 * could create them could also mark a milestone handled without anything being
 * sent, which would silently defeat the feature.
 */
import { supabase } from './supabase';

export type Reminder = {
  id: string;
  user_id: string;
  ref_type: 'document';
  ref_id: string;
  milestone: 6 | 3 | 1;
  remind_at: string;
  channels: string[];
  sent: boolean;
  superseded: boolean;
  acknowledged: boolean;
  created_at: string;
};

export type NotificationPreferences = {
  user_id: string;
  push_enabled: boolean;
  expo_push_token: string | null;
};

const COLUMNS =
  'id, user_id, ref_type, ref_id, milestone, remind_at, channels, sent, superseded, acknowledged, created_at';

/**
 * The banners owed right now: one-month reminders not yet acknowledged.
 *
 * F2 is specific that this persists across app opens until acknowledged, rather
 * than being a toast that can be missed once and never seen again — so the
 * acknowledgement is stored server-side, not in local state.
 */
export async function listActiveBanners(): Promise<Reminder[]> {
  const { data, error } = await supabase
    .from('reminders')
    .select(COLUMNS)
    .eq('milestone', 1)
    .eq('acknowledged', false)
    .eq('superseded', false)
    .order('remind_at', { ascending: true });

  if (error) throw new Error(error.message);
  return (data ?? []) as Reminder[];
}

export async function acknowledgeReminder(id: string): Promise<void> {
  const { error } = await supabase
    .from('reminders')
    .update({ acknowledged: true, acknowledged_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw new Error(error.message);
}

/** Everything sent for this account, newest first — for a history view. */
export async function listReminders(): Promise<Reminder[]> {
  const { data, error } = await supabase
    .from('reminders')
    .select(COLUMNS)
    .eq('superseded', false)
    .order('remind_at', { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as Reminder[];
}

export async function getNotificationPreferences(): Promise<NotificationPreferences | null> {
  const { data, error } = await supabase
    .from('notification_preferences')
    .select('user_id, push_enabled, expo_push_token')
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as NotificationPreferences | null) ?? null;
}

/**
 * Only push is settable. There is no email toggle here because there is no
 * email column to toggle — see 0005_reminders.sql for why that is structural
 * rather than an oversight.
 */
export async function setPushEnabled(enabled: boolean): Promise<void> {
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) throw new Error('You need to be logged in.');

  const { error } = await supabase
    .from('notification_preferences')
    .upsert(
      { user_id: auth.user.id, push_enabled: enabled, updated_at: new Date().toISOString() },
      { onConflict: 'user_id' }
    );
  if (error) throw new Error(error.message);
}

/**
 * Registering a device for push needs expo-notifications, which is not a
 * dependency yet. The column and the plumbing exist so the sweep can deliver
 * the moment a token is stored.
 */
export async function setPushToken(token: string): Promise<void> {
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) throw new Error('You need to be logged in.');

  const { error } = await supabase
    .from('notification_preferences')
    .upsert(
      { user_id: auth.user.id, expo_push_token: token, updated_at: new Date().toISOString() },
      { onConflict: 'user_id' }
    );
  if (error) throw new Error(error.message);
}
