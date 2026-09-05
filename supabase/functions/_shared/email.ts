/**
 * Transactional email, behind a provider interface.
 *
 * F2 needs outbound email and F5 later needs inbound parsing from the same
 * vendor. Neither account exists yet, so this is written to be configured by
 * environment variable and to fail *visibly* rather than pretend.
 *
 * Configure with:
 *   supabase secrets set EMAIL_PROVIDER=postmark EMAIL_FROM=... POSTMARK_SERVER_TOKEN=...
 *   supabase secrets set EMAIL_PROVIDER=mailgun  EMAIL_FROM=... MAILGUN_API_KEY=... MAILGUN_DOMAIN=...
 */

export type EmailMessage = {
  to: string;
  subject: string;
  text: string;
};

export type EmailResult = {
  delivered: boolean;
  provider: 'postmark' | 'mailgun' | 'none';
  reason?: string;
};

export function emailProvider(): 'postmark' | 'mailgun' | 'none' {
  const configured = (Deno.env.get('EMAIL_PROVIDER') ?? '').toLowerCase();
  if (configured === 'postmark' && Deno.env.get('POSTMARK_SERVER_TOKEN')) return 'postmark';
  if (configured === 'mailgun' && Deno.env.get('MAILGUN_API_KEY') && Deno.env.get('MAILGUN_DOMAIN')) {
    return 'mailgun';
  }
  return 'none';
}

export function isEmailConfigured(): boolean {
  return emailProvider() !== 'none' && Boolean(Deno.env.get('EMAIL_FROM'));
}

/**
 * Send one message.
 *
 * Never throws. A caller that cannot send must still be able to record that a
 * reminder was *owed* — losing that would mean the milestone is forgotten
 * entirely once the date passes. See the sweep: it writes the reminder row
 * regardless and leaves `sent` false, so configuring a provider later flushes
 * the backlog rather than silently dropping it.
 */
export async function sendEmail(message: EmailMessage): Promise<EmailResult> {
  const provider = emailProvider();
  const from = Deno.env.get('EMAIL_FROM');

  if (provider === 'none' || !from) {
    const reason = !from
      ? 'EMAIL_FROM is not set'
      : 'No email provider configured (set EMAIL_PROVIDER and its credentials)';
    console.warn(`email not sent to ${message.to}: ${reason}`);
    return { delivered: false, provider: 'none', reason };
  }

  try {
    if (provider === 'postmark') return await sendViaPostmark(message, from);
    return await sendViaMailgun(message, from);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.error(`email failed to ${message.to}: ${reason}`);
    return { delivered: false, provider, reason };
  }
}

async function sendViaPostmark(message: EmailMessage, from: string): Promise<EmailResult> {
  const response = await fetch('https://api.postmarkapp.com/email', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-Postmark-Server-Token': Deno.env.get('POSTMARK_SERVER_TOKEN') as string,
    },
    body: JSON.stringify({
      From: from,
      To: message.to,
      Subject: message.subject,
      TextBody: message.text,
      MessageStream: 'outbound',
    }),
  });

  if (!response.ok) {
    return { delivered: false, provider: 'postmark', reason: `HTTP ${response.status}` };
  }
  return { delivered: true, provider: 'postmark' };
}

async function sendViaMailgun(message: EmailMessage, from: string): Promise<EmailResult> {
  const domain = Deno.env.get('MAILGUN_DOMAIN') as string;
  const key = Deno.env.get('MAILGUN_API_KEY') as string;

  const body = new URLSearchParams({
    from,
    to: message.to,
    subject: message.subject,
    text: message.text,
  });

  const response = await fetch(`https://api.mailgun.net/v3/${domain}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${btoa(`api:${key}`)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  if (!response.ok) {
    return { delivered: false, provider: 'mailgun', reason: `HTTP ${response.status}` };
  }
  return { delivered: true, provider: 'mailgun' };
}

/**
 * Expo push. Needs no API key — the token identifies the device — so this half
 * works today, unlike email.
 */
export async function sendPush(
  token: string,
  title: string,
  body: string
): Promise<{ delivered: boolean; reason?: string }> {
  if (!token) return { delivered: false, reason: 'no push token registered' };

  try {
    const response = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ to: token, title, body, sound: 'default' }),
    });
    if (!response.ok) return { delivered: false, reason: `HTTP ${response.status}` };
    return { delivered: true };
  } catch (e) {
    return { delivered: false, reason: e instanceof Error ? e.message : String(e) };
  }
}
