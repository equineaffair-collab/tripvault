/**
 * F5 Path B — the inbound webhook.
 *
 * A user forwards a confirmation from their own mail app. It reaches Postmark
 * or Mailgun, which posts it here. No TripVault screen is open at that moment,
 * and there is no session to authenticate — F5 is explicit that the forwarding
 * address itself is the access control, because the user is inside their own
 * inbox and there is nothing else to check against.
 *
 * That makes this endpoint the one place where a stranger can cause a write, so
 * it is written defensively:
 *   - the provider's own signature is verified first, before anything is read
 *   - an address that matches nobody is counted and dropped, never stored
 *   - mail is recorded BEFORE extraction is attempted, so nothing is lost if
 *     extraction is unavailable, fails, or the plan does not include it
 *
 * Deploy (the provider posts without a session, by definition):
 *   supabase functions deploy inbound-email --no-verify-jwt
 *
 * Configure:
 *   supabase secrets set EMAIL_PROVIDER=postmark INBOUND_WEBHOOK_SECRET=...
 *   supabase secrets set EMAIL_PROVIDER=mailgun  MAILGUN_WEBHOOK_SIGNING_KEY=...
 *   supabase secrets set INBOUND_EMAIL_DOMAIN=trips.example.com
 */
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { extractBooking } from '../_shared/extraction.ts';

/** How much of a message body is kept. Matches the column's CHECK constraint. */
const MAX_BODY_CHARS = 20000;

function ok(body: unknown = { received: true }): Response {
  // A 2xx is what tells the provider to stop retrying. Everything this function
  // handles -- unreadable mail, a lapsed plan, an unknown address -- is handled,
  // not failed, so it answers 200 and records the outcome. Returning an error
  // would have the provider redeliver the same message for hours.
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response('Use POST.', { status: 405 });

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceRoleKey) {
    console.error('inbound-email is misconfigured');
    return new Response('Server is misconfigured.', { status: 500 });
  }

  const rawBody = await req.text();

  const verified = await verifyWebhook(req, rawBody);
  if (!verified.ok) {
    // 401 rather than 200: an unsigned request is not a message that arrived,
    // it is someone else calling this endpoint.
    console.warn('inbound-email rejected an unverified request:', verified.reason);
    return new Response('Unauthorized.', { status: 401 });
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response('Bad payload.', { status: 400 });
  }

  const message = normaliseMessage(payload);
  if (!message.to) return ok({ received: true, matched: false });

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const localPart = message.to.split('@')[0]?.toLowerCase() ?? '';

  const { data: address } = await admin
    .from('forwarding_addresses')
    .select('user_id')
    .eq('local_part', localPart)
    .maybeSingle();

  if (!address) {
    // Deliberately not recorded. There is no user to own the row, and storing
    // the content of mail sent to an address nobody has would mean collecting
    // messages from and about people with no relationship to this app.
    console.info('inbound-email: no such address');
    return ok({ received: true, matched: false });
  }

  const userId = address.user_id as string;

  // Recorded first, extracted second. If anything below fails, the message
  // still exists and can be read later -- the same trade F2 makes by writing a
  // reminder as owed before it can be delivered.
  const { data: record, error: recordError } = await admin
    .from('inbound_emails')
    .insert({
      user_id: userId,
      from_address: message.from?.slice(0, 320) ?? null,
      subject: message.subject?.slice(0, 500) ?? null,
      body_text: message.text ? message.text.slice(0, MAX_BODY_CHARS) : null,
      status: 'pending',
    })
    .select('id')
    .single();

  if (recordError) {
    console.error('inbound-email could not record a message', recordError);
    return new Response('Could not record.', { status: 500 });
  }

  await processMessage(admin, { inboundId: record.id as string, userId, message });

  return ok();
});

async function processMessage(
  admin: SupabaseClient,
  args: { inboundId: string; userId: string; message: InboundMessage }
): Promise<void> {
  const finish = (status: string, detail: string | null, tripItemId: string | null = null) =>
    admin
      .from('inbound_emails')
      .update({ status, detail, trip_item_id: tripItemId })
      .eq('id', args.inboundId);

  const { data: tier } = await admin.rpc('current_tier', { uid: args.userId });
  const { data: allowed } = await admin.rpc('tier_has_feature', {
    t: tier ?? 'free',
    f: 'smart_import',
  });

  if (!allowed) {
    // Held, not dropped. Someone whose plan lapsed forwarding a confirmation
    // should be told what happened and be able to get it back by upgrading --
    // silently binning their mail would be indefensible.
    await finish('rejected_tier', null);
    return;
  }

  const { text, html, ics, subject, from } = args.message;

  if (!text?.trim() && !html?.trim() && !ics?.trim()) {
    await finish('unreadable', 'The message had no readable content.');
    return;
  }

  // The HTML part is passed through deliberately: schema.org booking markup
  // lives there and nowhere else, and it is the one source that needs no
  // guessing at all. Reading only the plain-text part would throw away the
  // best answer in the message.
  const outcome = await extractBooking({
    text,
    html,
    ics,
    subject,
    fromAddress: from,
  });

  if (outcome.status !== 'extracted') {
    await finish(outcome.status === 'unreadable' ? 'unreadable' : 'failed', outcome.detail);
    return;
  }

  const b = outcome.booking;

  // Lands with a null trip_id: the holding area. The user was in their inbox,
  // not in a trip, so nothing here knows which trip this belongs to -- and
  // guessing is worse than asking, because a booking filed under the wrong trip
  // is one nobody goes looking for.
  const { data: item, error: itemError } = await admin
    .from('trip_items')
    .insert({
      trip_id: null,
      user_id: args.userId,
      type: b.type,
      provider: b.provider,
      confirmation_number: b.confirmationNumber,
      source: 'email',
      item_date: b.itemDate,
      amount_due: b.amountDue,
      due_date: b.dueDate,
      notes: b.notes,
    })
    .select('id')
    .single();

  if (itemError) {
    console.error('inbound-email could not save a booking', itemError);
    await finish('failed', 'The booking was read but could not be saved.');
    return;
  }

  // The method is recorded in the detail, so a wrong item can be traced back
  // to how it was read rather than guessed at later.
  await finish(
    'extracted',
    b.confidence === 'low'
      ? `Read from the wording of the email (${outcome.method}) — worth checking.`
      : `Read from the booking data in the email (${outcome.method}).`,
    item.id as string
  );
}

/* --------------------------------------------------------------------------
 * Provider payloads
 * ----------------------------------------------------------------------- */

type InboundMessage = {
  to: string | null;
  from: string | null;
  subject: string | null;
  text: string | null;
  /** The HTML part, which is where schema.org booking markup lives. */
  html: string | null;
  /** A calendar attachment, if the provider gave us one already decoded. */
  ics: string | null;
};

/**
 * Both providers post JSON with different field names. Normalised here rather
 * than branching in the handler, so switching vendors touches one function.
 */
function normaliseMessage(payload: Record<string, unknown>): InboundMessage {
  const str = (v: unknown): string | null =>
    typeof v === 'string' && v.trim() ? v.trim() : null;

  // Postmark
  if (payload.OriginalRecipient || payload.FromFull || payload.HtmlBody || payload.TextBody) {
    return {
      to: str(payload.OriginalRecipient) ?? str(payload.To),
      from: str(payload.From),
      subject: str(payload.Subject),
      text: str(payload.TextBody) ?? str(payload.StrippedTextReply),
      html: str(payload.HtmlBody),
      ics: calendarAttachment(payload.Attachments),
    };
  }

  // Mailgun (the "fully parsed" store/forward shape)
  return {
    to: str(payload.recipient) ?? str(payload.To) ?? str(payload.to),
    from: str(payload.sender) ?? str(payload.from),
    subject: str(payload.subject) ?? str(payload.Subject),
    text: str(payload['stripped-text']) ?? str(payload['body-plain']),
    html: str(payload['stripped-html']) ?? str(payload['body-html']),
    ics: null,
  };
}

/**
 * The .ics part of a Postmark payload, decoded.
 *
 * Attachments arrive base64 encoded. A calendar file is small and plain text,
 * so decoding one costs nothing; anything else is left alone -- this function
 * exists to read a booking, not to open attachments.
 */
function calendarAttachment(attachments: unknown): string | null {
  if (!Array.isArray(attachments)) return null;

  for (const raw of attachments) {
    const a = raw as Record<string, unknown>;
    const name = String(a.Name ?? '');
    const type = String(a.ContentType ?? '');
    const isCalendar = /\.ics$/i.test(name) || /text\/calendar/i.test(type);
    if (!isCalendar || typeof a.Content !== 'string') continue;

    try {
      return new TextDecoder().decode(
        Uint8Array.from(atob(a.Content), (c) => c.charCodeAt(0))
      );
    } catch {
      // A malformed attachment must not lose the message it came with.
      return null;
    }
  }
  return null;
}

/* --------------------------------------------------------------------------
 * Signature verification
 * ----------------------------------------------------------------------- */

type Verification = { ok: true } | { ok: false; reason: string };

/**
 * Postmark does not sign its inbound webhooks; the documented approach is a
 * secret in the URL. So the shared secret is compared here in constant time,
 * from a header or a query parameter.
 *
 * Mailgun does sign, with an HMAC over timestamp and token.
 */
async function verifyWebhook(req: Request, rawBody: string): Promise<Verification> {
  const provider = (Deno.env.get('EMAIL_PROVIDER') ?? '').toLowerCase();

  if (provider === 'mailgun') {
    const signingKey = Deno.env.get('MAILGUN_WEBHOOK_SIGNING_KEY');
    if (!signingKey) return { ok: false, reason: 'no Mailgun signing key configured' };
    return await verifyMailgun(rawBody, signingKey);
  }

  const secret = Deno.env.get('INBOUND_WEBHOOK_SECRET');
  if (!secret) {
    // Fails closed. An inbound endpoint with no secret set would accept a
    // message from anyone claiming to be any user's forwarding address, and the
    // only person who can tell that apart is whoever configures it.
    return { ok: false, reason: 'INBOUND_WEBHOOK_SECRET is not set' };
  }

  const url = new URL(req.url);
  const presented = req.headers.get('x-tripvault-secret') ?? url.searchParams.get('secret') ?? '';

  return timingSafeEqual(presented, secret)
    ? { ok: true }
    : { ok: false, reason: 'shared secret did not match' };
}

async function verifyMailgun(rawBody: string, signingKey: string): Promise<Verification> {
  let signature: { timestamp?: string; token?: string; signature?: string };
  try {
    const parsed = JSON.parse(rawBody) as Record<string, unknown>;
    signature = (parsed.signature as typeof signature) ?? {};
  } catch {
    return { ok: false, reason: 'unparseable body' };
  }

  const { timestamp, token, signature: provided } = signature;
  if (!timestamp || !token || !provided) return { ok: false, reason: 'no signature present' };

  // A signature is only good for a few minutes. Without this, a captured
  // request could be replayed indefinitely.
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > 300) return { ok: false, reason: 'signature too old' };

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(signingKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}${token}`));
  const expected = Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  return timingSafeEqual(provided, expected)
    ? { ok: true }
    : { ok: false, reason: 'HMAC did not match' };
}

/** Compares without leaking where two strings first differ. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
