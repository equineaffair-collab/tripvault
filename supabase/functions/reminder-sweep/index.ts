/**
 * F2 — the daily expiry sweep.
 *
 * Runs once a day from pg_cron. For every document with an expiry date, decides
 * whether a milestone is owed today, records it, and delivers on the channels
 * that milestone calls for.
 *
 * Deploy:
 *   supabase functions deploy reminder-sweep --no-verify-jwt
 * Schedule: see supabase/migrations/0006_reminder_cron.sql
 *
 * Authentication: this is a machine endpoint, not a user one. It is deployed
 * with --no-verify-jwt and guarded by a shared secret instead, because pg_cron
 * has no user session to present.
 */
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { planSweep, reminderText, type Milestone } from '../_shared/reminders.ts';
import { isEmailConfigured, sendEmail, sendPush } from '../_shared/email.ts';
import { todayIso } from '../_shared/dates.ts';

Deno.serve(async (req: Request) => {
  const expected = Deno.env.get('REMINDER_SWEEP_SECRET');
  const provided = req.headers.get('x-sweep-secret');

  // Fail closed. Without a secret set, anyone who found the URL could trigger
  // the sweep — which is mostly harmless but would burn email quota.
  if (!expected || provided !== expected) {
    return new Response(JSON.stringify({ error: 'Not authorised.' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceRoleKey) {
    return new Response(JSON.stringify({ error: 'Server is misconfigured.' }), { status: 500 });
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // A caller may pin the date, which is what makes this testable without
  // waiting months for a real milestone to arrive.
  let today = todayIso();
  try {
    const body = await req.json();
    if (typeof body?.today === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.today)) {
      today = body.today;
    }
  } catch {
    // no body is the normal case from cron
  }

  const summary = await runSweep(admin, today);
  return new Response(JSON.stringify(summary), {
    headers: { 'Content-Type': 'application/json' },
  });
});

async function runSweep(admin: SupabaseClient, today: string) {
  // Documents, with the traveler and owner they belong to.
  const { data: documents, error } = await admin
    .from('documents')
    .select('id, traveler_id, type, expiry_date, country, travelers!inner(id, name, user_id)')
    .not('expiry_date', 'is', null);

  if (error) {
    console.error('sweep could not read documents', error);
    return { ok: false, error: error.message };
  }

  const rows = (documents ?? []) as Array<{
    id: string;
    traveler_id: string;
    type: string;
    expiry_date: string;
    country: string | null;
    travelers: { id: string; name: string; user_id: string };
  }>;

  if (rows.length === 0) return { ok: true, today, considered: 0, created: 0, sent: 0 };

  // What has already been handled, so a milestone never fires twice.
  const { data: existing } = await admin
    .from('reminders')
    .select('ref_id, milestone')
    .in('ref_id', rows.map((r) => r.id));

  const handledByDocument: Record<string, number[]> = {};
  for (const r of (existing ?? []) as { ref_id: string; milestone: number }[]) {
    (handledByDocument[r.ref_id] ??= []).push(r.milestone);
  }

  const userIds = [...new Set(rows.map((r) => r.travelers.user_id))];
  const { data: prefRows } = await admin
    .from('notification_preferences')
    .select('user_id, push_enabled, expo_push_token')
    .in('user_id', userIds);

  const prefsByUser: Record<string, { push_enabled: boolean; expo_push_token: string | null }> = {};
  for (const p of (prefRows ?? []) as never[]) {
    const row = p as unknown as { user_id: string; push_enabled: boolean; expo_push_token: string | null };
    prefsByUser[row.user_id] = row;
  }

  const prefsByTraveler: Record<string, { pushEnabled: boolean }> = {};
  for (const r of rows) {
    prefsByTraveler[r.traveler_id] = {
      pushEnabled: prefsByUser[r.travelers.user_id]?.push_enabled ?? true,
    };
  }

  const planned = planSweep({
    documents: rows.map((r) => ({
      id: r.id,
      traveler_id: r.traveler_id,
      type: r.type,
      expiry_date: r.expiry_date,
      country: r.country,
    })),
    handledByDocument,
    today,
    prefsByTraveler,
  });

  const byDocument = new Map(rows.map((r) => [r.id, r]));
  let created = 0;
  let sent = 0;

  for (const item of planned) {
    const doc = byDocument.get(item.documentId);
    if (!doc) continue;

    const userId = doc.travelers.user_id;

    // Milestones this one overtook are recorded as superseded so they never
    // fire late. Someone adding an almost-expired passport gets one notice,
    // not three.
    if (item.supersede.length > 0) {
      await admin.from('reminders').insert(
        item.supersede.map((m) => ({
          user_id: userId,
          ref_type: 'document',
          ref_id: item.documentId,
          milestone: m,
          remind_at: today,
          channels: [],
          sent: true,
          sent_at: new Date().toISOString(),
          superseded: true,
        }))
      );
    }

    const text = reminderText({
      travelerName: doc.travelers.name,
      documentType: doc.type,
      expiryDate: item.expiryDate,
      milestone: item.milestone as Milestone,
      expired: item.expired,
    });

    // The row is written BEFORE delivery is attempted, and `sent` stays false
    // until it succeeds. If email is not configured yet, the reminder is still
    // recorded as owed — so setting up a provider later flushes the backlog
    // rather than silently losing everything that came due in the meantime.
    const { data: inserted, error: insertError } = await admin
      .from('reminders')
      .insert({
        user_id: userId,
        ref_type: 'document',
        ref_id: item.documentId,
        milestone: item.milestone,
        remind_at: today,
        channels: item.channels,
        sent: false,
      })
      .select('id')
      .single();

    if (insertError) {
      // Almost certainly the unique index doing its job on a same-day re-run.
      console.warn('reminder not created', insertError.message);
      continue;
    }
    created++;

    let delivered = false;

    if (item.channels.includes('email')) {
      const { data: userInfo } = await admin.auth.admin.getUserById(userId);
      const address = userInfo.user?.email;
      if (address) {
        const result = await sendEmail({ to: address, subject: text.subject, text: text.body });
        delivered = result.delivered;
      }
    }

    if (item.channels.includes('push')) {
      const token = prefsByUser[userId]?.expo_push_token;
      if (token) await sendPush(token, text.subject, text.body);
      // Push is a convenience layer, not a substitute: its outcome deliberately
      // does not decide whether the reminder counts as delivered.
    }

    if (delivered) {
      await admin
        .from('reminders')
        .update({ sent: true, sent_at: new Date().toISOString() })
        .eq('id', inserted.id);
      sent++;
    }
  }

  return {
    ok: true,
    today,
    considered: rows.length,
    created,
    sent,
    emailConfigured: isEmailConfigured(),
  };
}
