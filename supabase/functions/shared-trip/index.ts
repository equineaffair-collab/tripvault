/**
 * F9 mechanism 2 — the one-off share link.
 *
 * For a genuine outsider: an emergency contact who is not a traveler profile
 * and has no account at all. The token IS the access control, so this function
 * is the only way in and there is deliberately no RLS path for `anon` anywhere
 * in migration 0010. That is what keeps "documents are excluded unless the
 * organizer toggled them on for this link" a single branch in one place rather
 * than a policy someone could weaken without noticing.
 *
 * Completely separate from the linked-login path in `invite`. Different
 * security model, different table, different function; neither calls the other.
 *
 * Deploy (note the flag -- `view` is answered without a session, which is the
 * entire point of a share link):
 *   supabase functions deploy shared-trip --no-verify-jwt
 *
 * Because the platform is not checking a JWT for us, `create` verifies the
 * caller's token itself before doing anything.
 *
 * This function deliberately does NOT hold DOCUMENT_ENCRYPTION_KEY. A share
 * recipient never sees a decrypted document number; the key stays in exactly
 * one function, which is the property the whole encryption design rests on.
 *
 * Note on the page format: Supabase's gateway rewrites an HTML response served
 * from the default functions domain to `text/plain`, so the recipient page is
 * plain text by default and HTML only when SHARE_PAGE_FORMAT=html is set --
 * see the rendering section at the bottom of this file.
 */
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { clientHash, generateToken, hashToken, normaliseToken } from '../_shared/tokens.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

const MAX_EXPIRY_DAYS = 365;

/** Rate limit: failed lookups per client, per window. */
const RATE_WINDOW_MINUTES = 15;
const RATE_MAX_FAILURES = 10;

/** Signed URLs are short-lived; a share recipient saves the file, not the link. */
const SIGNED_URL_SECONDS = 60;

/** Expired, revoked, never-existed and malformed all read the same from outside. */
const BAD_LINK = 'That link is not valid. It may have expired or been revoked.';

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST' && req.method !== 'GET') return json({ error: 'Use POST.' }, 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');

  if (!supabaseUrl || !serviceRoleKey || !anonKey) {
    console.error('shared-trip function is misconfigured');
    return json({ error: 'Server is misconfigured.' }, 500);
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // GET is how a recipient actually opens the link. They have no account and
  // very possibly no app, so the function renders the trip itself rather than
  // pointing at a web front end that does not exist. A share link nobody can
  // open is not a share link.
  if (req.method === 'GET') {
    const token = new URL(req.url).searchParams.get('t');
    return await handleView(admin, req, { token }, 'page');
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  try {
    if (body.action === 'view') return await handleView(admin, req, body, 'json');

    if (body.action === 'create') {
      const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
      if (!jwt) return json({ error: 'Not authenticated.' }, 401);

      const { data: userData, error: userError } = await admin.auth.getUser(jwt);
      if (userError || !userData.user) return json({ error: 'Not authenticated.' }, 401);

      return await handleCreate({ supabaseUrl, anonKey, jwt, userId: userData.user.id, body });
    }

    return json({ error: 'Unknown action.' }, 400);
  } catch (e) {
    console.error('shared-trip function failed', e);
    return json({ error: 'Something went wrong.' }, 500);
  }
});

/**
 * Mint a share link for one of the caller's own trips.
 *
 * Inserted as the CALLER so the Family-tier gate and the trip-ownership check
 * in 0010's trigger both apply. The service role would bypass them.
 */
async function handleCreate(args: {
  supabaseUrl: string;
  anonKey: string;
  jwt: string;
  userId: string;
  body: Record<string, unknown>;
}): Promise<Response> {
  const tripId = args.body.tripId;
  if (typeof tripId !== 'string' || !tripId) return json({ error: 'Which trip?' }, 400);

  const label = typeof args.body.label === 'string' ? args.body.label.trim().slice(0, 60) : null;

  // Documents are off unless the caller asked for them in this specific
  // request. Anything other than a literal true is a no.
  const includesDocuments = args.body.includesDocuments === true;

  let expiresAt: string | null = null;
  const days = Number(args.body.expiresInDays);
  if (Number.isFinite(days) && days >= 1) {
    expiresAt = new Date(
      Date.now() + Math.min(Math.floor(days), MAX_EXPIRY_DAYS) * 86_400_000
    ).toISOString();
  }

  const asUser = createClient(args.supabaseUrl, args.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${args.jwt}` } },
  });

  const token = generateToken();

  const { data, error } = await asUser
    .from('share_links')
    .insert({
      trip_id: tripId,
      created_by: args.userId,
      token_hash: await hashToken(token),
      label: label || null,
      includes_documents: includesDocuments,
      expires_at: expiresAt,
    })
    .select('id, expires_at, includes_documents')
    .single();

  if (error) return json({ error: error.message }, 400);

  return json({
    shareId: data.id,
    token,
    expiresAt: data.expires_at,
    includesDocuments: data.includes_documents,
  });
}

/**
 * Read a shared trip. No session, no account -- the token is everything.
 */
async function handleView(
  admin: SupabaseClient,
  req: Request,
  body: Record<string, unknown>,
  shape: 'json' | 'page'
): Promise<Response> {
  const fail = (message: string, status: number) =>
    shape === 'page' ? pageError(message, status) : json({ error: message }, status);

  const who = await clientHash(req);

  const since = new Date(Date.now() - RATE_WINDOW_MINUTES * 60_000).toISOString();
  const { count: recentFailures } = await admin
    .from('share_link_attempts')
    .select('id', { count: 'exact', head: true })
    .eq('client_hash', who)
    .eq('succeeded', false)
    .gte('at', since);

  if ((recentFailures ?? 0) >= RATE_MAX_FAILURES) {
    return fail('Too many attempts. Try again later.', 429);
  }

  const note = (succeeded: boolean) =>
    admin.from('share_link_attempts').insert({ client_hash: who, succeeded });

  const token = normaliseToken(body.token);
  if (!token) {
    await note(false);
    return fail(BAD_LINK, 404);
  }

  const { data: link } = await admin
    .from('share_links')
    .select('id, trip_id, includes_documents, revoked, expires_at')
    .eq('token_hash', await hashToken(token))
    .maybeSingle();

  const usable =
    link && !link.revoked && (!link.expires_at || Date.parse(link.expires_at) > Date.now());

  if (!usable) {
    await note(false);
    return fail(BAD_LINK, 404);
  }

  await note(true);

  const { data: trip } = await admin
    .from('trips')
    .select('id, name, destination, start_date, end_date')
    .eq('id', link.trip_id)
    .maybeSingle();

  if (!trip) return fail(BAD_LINK, 404);

  // Itinerary. `amount_due` and `due_date` are left out on purpose: what a
  // booking cost is the organizer's business, and an emergency contact needs
  // where to be and when, not what was paid.
  const { data: items } = await admin
    .from('trip_items')
    .select('id, type, provider, confirmation_number, external_link, item_date, notes')
    .eq('trip_id', trip.id)
    .order('item_date', { ascending: true, nullsFirst: false });

  const { data: checklist } = await admin
    .from('trip_checklist_items')
    .select('id, label, category, status')
    .eq('trip_id', trip.id)
    .order('category', { ascending: true });

  const payload: Record<string, unknown> = {
    trip: {
      id: trip.id,
      name: trip.name,
      destination: trip.destination,
      startDate: trip.start_date,
      endDate: trip.end_date,
    },
    items: (items ?? []).map((i) => ({
      id: i.id,
      type: i.type,
      provider: i.provider,
      confirmationNumber: i.confirmation_number,
      externalLink: i.external_link,
      itemDate: i.item_date,
      notes: i.notes,
    })),
    checklist: checklist ?? [],
    includesDocuments: link.includes_documents,
    documents: [],
  };

  if (link.includes_documents) {
    payload.documents = await documentsForTrip(admin, trip.id);
  }

  return shape === 'page' ? renderPage(payload) : json(payload);
}

/**
 * Documents for the attendees of a shared trip, when the organizer turned that
 * on for this link.
 *
 * The decrypted number is NOT included, at any setting. The scan itself is what
 * an emergency contact needs -- and handing an unauthenticated bearer-token
 * holder a passport number in plain text is the exact use APP 9 warns about.
 * Keeping the number out also means this function never needs the encryption
 * key, so the key still lives in exactly one place.
 */
async function documentsForTrip(
  admin: SupabaseClient,
  tripId: string
): Promise<Record<string, unknown>[]> {
  const { data: attendees } = await admin
    .from('trip_travelers')
    .select('traveler_id, travelers ( id, name )')
    .eq('trip_id', tripId);

  const travelerIds = (attendees ?? []).map((a) => a.traveler_id as string);
  if (travelerIds.length === 0) return [];

  const names = new Map<string, string>();
  for (const a of attendees ?? []) {
    const t = a.travelers as { id: string; name: string } | null;
    if (t) names.set(t.id, t.name);
  }

  const { data: docs } = await admin
    .from('documents')
    .select('id, traveler_id, type, country, expiry_date, file_path')
    .in('traveler_id', travelerIds);

  const out: Record<string, unknown>[] = [];

  for (const d of docs ?? []) {
    let fileUrl: string | null = null;

    if (d.file_path) {
      const { data: signed } = await admin.storage
        .from('documents')
        .createSignedUrl(d.file_path as string, SIGNED_URL_SECONDS);
      fileUrl = signed?.signedUrl ?? null;
    }

    out.push({
      id: d.id,
      travelerName: names.get(d.traveler_id as string) ?? 'Traveler',
      type: d.type,
      country: d.country,
      expiryDate: d.expiry_date,
      fileUrl,
    });
  }

  return out;
}

/* --------------------------------------------------------------------------
 * The page a recipient actually sees.
 *
 * Two formats, and the reason is a platform constraint found by opening a real
 * share link rather than by reading docs:
 *
 * Supabase's Edge Function gateway REWRITES the Content-Type of any HTML
 * response served from `<ref>.functions.supabase.co` to `text/plain`, and adds
 * `X-Content-Type-Options: nosniff` and a `sandbox` CSP. So an HTML page served
 * from the default domain does not render — the recipient is shown the markup.
 * That is deliberate on Supabase's part (it stops the shared domain being used
 * to host phishing pages) and there is no header we can set to opt out.
 *
 * So the default is a formatted PLAIN TEXT page, which renders correctly for
 * everyone today with nothing bought or configured. Set SHARE_PAGE_FORMAT=html
 * once the functions are behind a custom domain, where our Content-Type is
 * honoured.
 *
 * Both formats are server-rendered with no scripts and no external assets. A
 * share recipient is by definition someone we know nothing about, on a device
 * we know nothing about, quite possibly on airport wifi.
 * ----------------------------------------------------------------------- */

function pageFormat(): 'html' | 'text' {
  return (Deno.env.get('SHARE_PAGE_FORMAT') ?? '').toLowerCase() === 'html' ? 'html' : 'text';
}

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Headers a shared trip always carries, whichever format it is in. */
const PAGE_HEADERS = {
  // A shared trip is not something to cache anywhere but the reader's own
  // screen, and never something a search engine should hold.
  'Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex, nofollow',
  'Referrer-Policy': 'no-referrer',
};

const PAGE_CSS = `
  :root { color-scheme: light dark; }
  body { font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         margin: 0; padding: 24px 18px 64px; max-width: 620px; margin-inline: auto;
         background: #fbfbfa; color: #1a1a19; }
  @media (prefers-color-scheme: dark) { body { background: #14140f; color: #f0efea; } }
  h1 { font-size: 1.45rem; margin: 0 0 4px; }
  h2 { font-size: 1rem; text-transform: uppercase; letter-spacing: .06em;
       opacity: .6; margin: 32px 0 10px; }
  .sub { opacity: .7; margin: 0 0 8px; }
  .card { border: 1px solid rgba(128,128,128,.28); border-radius: 10px;
          padding: 12px 14px; margin-bottom: 10px; }
  .card .when { font-variant-numeric: tabular-nums; opacity: .7; font-size: .9rem; }
  .muted { opacity: .6; }
  .note { border-left: 3px solid #c98a2b; padding: 10px 12px; margin: 20px 0;
          background: rgba(201,138,43,.09); border-radius: 0 8px 8px 0; font-size: .93rem; }
  ul { padding-left: 20px; margin: 0; }
  li { margin-bottom: 6px; }
  li.done { opacity: .5; text-decoration: line-through; }
  a { color: inherit; }
  footer { margin-top: 44px; font-size: .82rem; opacity: .55; }
`;

function htmlShell(title: string, inner: string, status = 200): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width, initial-scale=1">` +
      `<meta name="robots" content="noindex, nofollow">` +
      `<title>${esc(title)}</title><style>${PAGE_CSS}</style></head><body>${inner}</body></html>`,
    { status, headers: { ...PAGE_HEADERS, 'Content-Type': 'text/html; charset=utf-8' } }
  );
}

function textShell(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { ...PAGE_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

function pageError(message: string, status: number): Response {
  return pageFormat() === 'html'
    ? htmlShell('TripVault', `<h1>Sorry</h1><p class="sub">${esc(message)}</p>`, status)
    : textShell(`TripVault\n\n${message}\n`, status);
}

function formatWhen(value: unknown): string {
  if (!value) return '';
  const d = new Date(String(value));
  if (Number.isNaN(d.getTime())) return '';
  return d.toUTCString().replace(/:\d\d GMT$/, ' UTC');
}

const ITEM_LABELS: Record<string, string> = {
  flight: 'Flight',
  accommodation: 'Stay',
  car_hire: 'Car hire',
  transfer: 'Transfer',
  activity: 'Activity',
  other: 'Booking',
};

const FOOTER =
  'Shared with you from TripVault. This is a read-only view of one trip — it does not ' +
  'give access to anything else in the account, and the person who shared it can revoke ' +
  'this link at any time.';

const DOCUMENT_NOTE =
  'These links stop working about a minute after this page loaded. Save anything you ' +
  'need now, or reload the page for fresh ones.';

function htmlPage(payload: Record<string, unknown>): Response {
  const trip = payload.trip as Record<string, unknown>;
  const items = payload.items as Record<string, unknown>[];
  const checklist = payload.checklist as Record<string, unknown>[];
  const documents = payload.documents as Record<string, unknown>[];

  const dates = [trip.startDate, trip.endDate].filter(Boolean).map(esc).join(' – ');

  let out = `<h1>${esc(trip.name)}</h1>`;
  if (trip.destination) out += `<p class="sub">${esc(trip.destination)}</p>`;
  if (dates) out += `<p class="sub">${dates}</p>`;

  out += `<h2>Itinerary</h2>`;
  if (items.length === 0) {
    out += `<p class="muted">Nothing booked yet.</p>`;
  } else {
    for (const i of items) {
      const when = formatWhen(i.itemDate);
      out += `<div class="card"><strong>${esc(ITEM_LABELS[String(i.type)] ?? 'Booking')}</strong>`;
      if (i.provider) out += ` — ${esc(i.provider)}`;
      if (when) out += `<div class="when">${esc(when)}</div>`;
      if (i.confirmationNumber) out += `<div class="muted">Ref ${esc(i.confirmationNumber)}</div>`;
      if (i.notes) out += `<div class="muted">${esc(i.notes)}</div>`;
      if (i.externalLink) {
        out += `<div><a rel="noopener noreferrer nofollow" href="${esc(i.externalLink)}">Booking link</a></div>`;
      }
      out += `</div>`;
    }
  }

  out += `<h2>Checklist</h2>`;
  if (checklist.length === 0) {
    out += `<p class="muted">Nothing on the list.</p>`;
  } else {
    out += `<ul>`;
    for (const c of checklist) {
      out += `<li class="${c.status === 'done' ? 'done' : ''}">${esc(c.label)}</li>`;
    }
    out += `</ul>`;
  }

  if (payload.includesDocuments) {
    out += `<h2>Documents</h2>`;
    if (documents.length === 0) {
      out += `<p class="muted">No documents saved for this trip.</p>`;
    } else {
      out += `<div class="note">${esc(DOCUMENT_NOTE)}</div>`;
      for (const d of documents) {
        out += `<div class="card"><strong>${esc(d.travelerName)}</strong> — ${esc(d.type)}`;
        if (d.country) out += ` (${esc(d.country)})`;
        if (d.expiryDate) out += `<div class="muted">Expires ${esc(d.expiryDate)}</div>`;
        if (d.fileUrl) {
          out += `<div><a rel="noopener noreferrer nofollow" href="${esc(d.fileUrl)}">Open scan</a></div>`;
        } else {
          out += `<div class="muted">No scan saved.</div>`;
        }
        out += `</div>`;
      }
    }
  }

  out += `<footer>${esc(FOOTER)}</footer>`;

  return htmlShell(String(trip.name ?? 'Shared trip'), out);
}

/**
 * The same trip as plain text.
 *
 * Not a fallback in the apologetic sense — it is the format that actually
 * arrives readable today, so it is what most recipients will see. Laid out to
 * be legible in a phone browser with no styling at all: short lines, blank
 * lines between blocks, headings underlined with dashes.
 */
function textPage(payload: Record<string, unknown>): Response {
  const trip = payload.trip as Record<string, unknown>;
  const items = payload.items as Record<string, unknown>[];
  const checklist = payload.checklist as Record<string, unknown>[];
  const documents = payload.documents as Record<string, unknown>[];

  const lines: string[] = [];
  const heading = (text: string) => {
    lines.push('', text.toUpperCase(), '-'.repeat(text.length), '');
  };

  lines.push(String(trip.name ?? 'Shared trip'));
  lines.push('='.repeat(String(trip.name ?? 'Shared trip').length));
  if (trip.destination) lines.push(String(trip.destination));
  const dates = [trip.startDate, trip.endDate].filter(Boolean).join(' - ');
  if (dates) lines.push(dates);

  heading('Itinerary');
  if (items.length === 0) {
    lines.push('Nothing booked yet.');
  } else {
    for (const i of items) {
      const title = ITEM_LABELS[String(i.type)] ?? 'Booking';
      lines.push(i.provider ? `${title} - ${i.provider}` : title);
      const when = formatWhen(i.itemDate);
      if (when) lines.push(`  ${when}`);
      if (i.confirmationNumber) lines.push(`  Ref ${i.confirmationNumber}`);
      if (i.notes) lines.push(`  ${i.notes}`);
      if (i.externalLink) lines.push(`  ${i.externalLink}`);
      lines.push('');
    }
  }

  heading('Checklist');
  if (checklist.length === 0) {
    lines.push('Nothing on the list.');
  } else {
    for (const c of checklist) {
      lines.push(`${c.status === 'done' ? '[x]' : '[ ]'} ${c.label}`);
    }
  }

  if (payload.includesDocuments) {
    heading('Documents');
    if (documents.length === 0) {
      lines.push('No documents saved for this trip.');
    } else {
      lines.push(DOCUMENT_NOTE, '');
      for (const d of documents) {
        let line = `${d.travelerName} - ${d.type}`;
        if (d.country) line += ` (${d.country})`;
        lines.push(line);
        if (d.expiryDate) lines.push(`  Expires ${d.expiryDate}`);
        lines.push(d.fileUrl ? `  ${d.fileUrl}` : '  No scan saved.');
        lines.push('');
      }
    }
  }

  lines.push('', '-'.repeat(60), FOOTER, '');

  return textShell(lines.join('\n'));
}

function renderPage(payload: Record<string, unknown>): Response {
  return pageFormat() === 'html' ? htmlPage(payload) : textPage(payload);
}
