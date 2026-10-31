/**
 * TJS Design — Checkout Worker
 * Handles Stripe payments + subscriptions + Google Calendar booking + contact form
 *
 * Environment secrets (Cloudflare Worker Settings → Variables):
 *   STRIPE_SECRET_KEY      — sk_live_...
 *   GOOGLE_CLIENT_ID       — OAuth client ID
 *   GOOGLE_CLIENT_SECRET   — OAuth client secret
 *   GOOGLE_REFRESH_TOKEN   — set after running /oauth/start once
 *   RESEND_API_KEY         — Resend API key, used to email contact form + payment notifications
 *   STRIPE_WEBHOOK_SECRET  — whsec_... signing secret for the /stripe-webhook endpoint
 *
 * Routes:
 *   GET  /oauth/start             →  redirect to Google consent screen
 *   GET  /oauth/callback          →  exchange code, display refresh token
 *   GET  /calendar/slots           →  return available 30-min booking slots (checkout flow)
 *   POST /calendar/book           →  create 30-min intake-call calendar event (checkout flow)
 *   GET  /calendar/prospect-slots →  return available 15-min prospect slots (schedule page)
 *   POST /calendar/book-prospect  →  create 15-min prospect call event, no Google Meet, phone call
 *   POST /create-payment-intent   →  { clientSecret, subscriptionId } — creates the client's
 *                                     year-one plan as a Stripe Subscription (monthly price) with
 *                                     the upfront fee billed once on the first invoice. See PLANS.
 *   POST /payment-confirmed       →  locks in the 12-month agreement (see ensureContractSchedule)
 *                                     and emails Trevor. Called by the browser right after payment.
 *   POST /stripe-webhook          →  Stripe → Worker backup for the same lock-in, so it still
 *                                     happens if the browser closes before /payment-confirmed.
 *   POST /contact                 →  email a footer contact-form submission via Resend
 */

// ── Plans (pricing model introduced 2026-10-30) ─────────────────────────────
// Prices are looked up in Stripe by lookup_key (created by stripe-setup-prices.sh),
// so no price IDs need to be pasted into this file.
//
// Year one is a 12-month agreement: upfront fee (if any) + 12 monthly payments.
// After the 12th payment the subscription moves to Essential Care month-to-month.
const PLANS = {
  own:      { label: 'Own It',    upfront: 'tjs_upfront_999',  monthly: 'tjs_y1_own_2999',      upfrontCents: 99999, monthlyCents: 2999 },
  balanced: { label: 'Balanced',  upfront: 'tjs_upfront_499',  monthly: 'tjs_y1_balanced_7999', upfrontCents: 49999, monthlyCents: 7999 },
  zero:     { label: 'Zero Down', upfront: null,               monthly: 'tjs_y1_zero_12999',    upfrontCents: 0,     monthlyCents: 12999 },
};
const YEAR_ONE_PAYMENTS = 12;
const AFTER_YEAR_ONE = 'tjs_essential_m2m_2999'; // Essential Care, month-to-month, $29.99/mo
const TERMS_VERSION = '2026-10-30';

let _priceCache = null;
async function priceIds(env) {
  if (_priceCache) return _priceCache;
  const keys = new Set([AFTER_YEAR_ONE]);
  Object.values(PLANS).forEach(p => { keys.add(p.monthly); if (p.upfront) keys.add(p.upfront); });
  const qs = new URLSearchParams({ active: 'true', limit: '100' });
  keys.forEach(k => qs.append('lookup_keys[]', k));
  const res = await fetch(`${STRIPE_API}/prices?${qs}`, { headers: STRIPE_HEADERS(env) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'Could not load prices.');
  const map = {};
  (data.data || []).forEach(p => { map[p.lookup_key] = p.id; });
  const missing = [...keys].filter(k => !map[k]);
  if (missing.length) throw new Error('Checkout is not configured yet (missing prices: ' + missing.join(', ') + ').');
  _priceCache = map;
  return map;
}

const ALLOWED_ORIGINS = [
  'https://tjsdesign.online',
  'https://www.tjsdesign.online',
  'https://metatrev89.github.io',
  'http://localhost',
  'http://127.0.0.1',
];

const CORS = (origin) => ({
  'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
});

const OAUTH_REDIRECT = 'https://tjs-checkout.trevorspencer89.workers.dev/oauth/callback';
const GOOGLE_SCOPES  = 'https://www.googleapis.com/auth/calendar';

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const corsHeaders = CORS(origin);
    const url = new URL(request.url);

    // Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // ── GET /oauth/start ──────────────────────────────────────────────────
    if (url.pathname === '/oauth/start') {
      const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      authUrl.searchParams.set('client_id',     env.GOOGLE_CLIENT_ID);
      authUrl.searchParams.set('redirect_uri',  OAUTH_REDIRECT);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('scope',         GOOGLE_SCOPES);
      authUrl.searchParams.set('access_type',   'offline');
      authUrl.searchParams.set('prompt',        'consent');
      return Response.redirect(authUrl.toString(), 302);
    }

    // ── GET /oauth/callback ───────────────────────────────────────────────
    if (url.pathname === '/oauth/callback') {
      const code = url.searchParams.get('code');
      if (!code) return new Response('Missing code', { status: 400 });

      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id:     env.GOOGLE_CLIENT_ID,
          client_secret: env.GOOGLE_CLIENT_SECRET,
          redirect_uri:  OAUTH_REDIRECT,
          grant_type:    'authorization_code',
        }),
      });

      const tokens = await tokenRes.json();
      if (!tokenRes.ok) {
        return new Response(JSON.stringify(tokens), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response(`
        <!DOCTYPE html>
        <html><body style="font-family:sans-serif;padding:40px;max-width:600px;margin:auto">
          <h2>✅ Google Calendar authorized!</h2>
          <p>Copy this refresh token and add it as a Worker secret named <strong>GOOGLE_REFRESH_TOKEN</strong>:</p>
          <textarea rows="4" style="width:100%;font-size:13px;padding:8px;font-family:monospace">${tokens.refresh_token}</textarea>
          <p style="margin-top:16px;color:#555">Once saved as a secret and redeployed, your Worker can access your calendar indefinitely.</p>
        </body></html>
      `, { headers: { 'Content-Type': 'text/html' } });
    }

    // ── GET /calendar/slots ───────────────────────────────────────────────
    if (url.pathname === '/calendar/slots' && request.method === 'GET') {
      try {
        const accessToken = await getAccessToken(env);
        const slots = await getAvailableSlots(accessToken);
        return json({ slots }, 200, corsHeaders);
      } catch (err) {
        return json({ error: err.message }, 500, corsHeaders);
      }
    }

    // ── POST /calendar/book ───────────────────────────────────────────────
    if (url.pathname === '/calendar/book' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch {
        return json({ error: 'Invalid JSON' }, 400, corsHeaders);
      }

      const { name, email, slot } = body;
      if (!name || !email || !slot) {
        return json({ error: 'name, email, and slot are required.' }, 400, corsHeaders);
      }

      try {
        const accessToken = await getAccessToken(env);
        const event = await bookSlot(accessToken, { name, email, slot });
        return json({ success: true, eventId: event.id }, 200, corsHeaders);
      } catch (err) {
        return json({ error: err.message }, 500, corsHeaders);
      }
    }

    // ── GET /calendar/prospect-slots ─────────────────────────────────────
    if (url.pathname === '/calendar/prospect-slots' && request.method === 'GET') {
      try {
        const accessToken = await getAccessToken(env);
        const slots = await getProspectSlots(accessToken);
        return json({ slots }, 200, corsHeaders);
      } catch (err) {
        return json({ error: err.message }, 500, corsHeaders);
      }
    }

    // ── POST /calendar/book-prospect ──────────────────────────────────────
    if (url.pathname === '/calendar/book-prospect' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch {
        return json({ error: 'Invalid JSON' }, 400, corsHeaders);
      }

      const { name, email, phone, biz, note, slot, slotDate, slotTime } = body;
      if (!name || !email || !slot) {
        return json({ error: 'name, email, and slot are required.' }, 400, corsHeaders);
      }

      try {
        const accessToken = await getAccessToken(env);
        const event = await bookProspectSlot(accessToken, { name, email, phone, biz, note, slot });
        // Best-effort notification email to Trevor — don't let it fail the booking
        try {
          await sendProspectBookingEmail(env, { name, phone, email, biz, note, slotDate, slotTime });
        } catch (emailErr) {
          console.error('Prospect booking email failed:', emailErr);
        }
        return json({ success: true, eventId: event.id }, 200, corsHeaders);
      } catch (err) {
        return json({ error: err.message }, 500, corsHeaders);
      }
    }

    // ── POST /create-payment-intent ───────────────────────────────────────
    if (url.pathname === '/create-payment-intent' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch {
        return json({ error: 'Invalid JSON' }, 400, corsHeaders);
      }

      const { name, email, plan, agreed } = body;
      if (!name || !email) {
        return json({ error: 'Name and email are required.' }, 400, corsHeaders);
      }
      const cfg = PLANS[plan];
      if (!cfg) return json({ error: 'Please choose a plan.' }, 400, corsHeaders);
      if (agreed !== true) {
        return json({ error: 'Please accept the 12-month agreement to continue.' }, 400, corsHeaders);
      }

      try {
        const ids = await priceIds(env);
        const customer = await stripeCreateCustomer(env, { name, email });
        const sub = await stripeCreateSubscription(env, {
          customer: customer.id,
          monthlyPrice: ids[cfg.monthly],
          upfrontPrice: cfg.upfront ? ids[cfg.upfront] : null,
          name, email, plan,
          agreedAt: new Date().toISOString(),
          ip: request.headers.get('CF-Connecting-IP') || '',
        });

        const pi = sub.latest_invoice && sub.latest_invoice.payment_intent;
        if (!pi || !pi.client_secret) {
          throw new Error('Subscription created but no payment intent was returned.');
        }

        return json({ clientSecret: pi.client_secret, subscriptionId: sub.id }, 200, corsHeaders);
      } catch (err) {
        console.error('Stripe error:', err);
        return json({ error: err.message || 'Payment setup failed.' }, 400, corsHeaders);
      }
    }

    // ── POST /payment-confirmed ─────────────────────────────────────────────
    if (url.pathname === '/payment-confirmed' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch {
        return json({ error: 'Invalid JSON' }, 400, corsHeaders);
      }

      const { name, email, plan, subscriptionId } = body;
      if (!name || !email) {
        return json({ error: 'Name and email are required.' }, 400, corsHeaders);
      }

      // Lock the 12-month agreement into Stripe. The webhook does the same thing as a
      // backup, and ensureContractSchedule is safe to call twice.
      let scheduleNote = '';
      if (subscriptionId) {
        try { scheduleNote = await ensureContractSchedule(env, subscriptionId); }
        catch (err) { scheduleNote = 'Schedule NOT set: ' + err.message; console.error(err); }
      }

      try {
        await sendPaymentNotificationEmail(env, { name, email, plan, subscriptionId, scheduleNote });
      } catch (err) {
        // Never let a notification-email failure look like a problem to the client —
        // the payment itself already succeeded by the time this is called.
        console.error('Payment notification email failed:', err);
      }
      return json({ success: true }, 200, corsHeaders);
    }

    // ── POST /stripe-webhook ─────────────────────────────────────────────────
    // Configure in Stripe → Developers → Webhooks: endpoint …/stripe-webhook,
    // event invoice.paid. Signing secret goes in STRIPE_WEBHOOK_SECRET.
    if (url.pathname === '/stripe-webhook' && request.method === 'POST') {
      const payload = await request.text();
      const ok = await verifyStripeSignature(payload, request.headers.get('Stripe-Signature') || '', env.STRIPE_WEBHOOK_SECRET);
      if (!ok) return new Response('Bad signature', { status: 400 });
      const event = JSON.parse(payload);
      if (event.type === 'invoice.paid') {
        const inv = event.data.object;
        const subId = inv.subscription || inv.parent?.subscription_details?.subscription;
        if (subId && inv.billing_reason === 'subscription_create') {
          try { await ensureContractSchedule(env, subId); }
          catch (err) { console.error('Webhook schedule error:', err); return new Response('Retry', { status: 500 }); }
        }
      }
      return new Response('ok');
    }

    // ── POST /contact ──────────────────────────────────────────────────────
    if (url.pathname === '/contact' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch {
        return json({ error: 'Invalid JSON' }, 400, corsHeaders);
      }

      const { name, phone, email, company, message } = body;
      // Honeypot: real visitors never fill this hidden field — bots often do.
      if (company) {
        return json({ success: true }, 200, corsHeaders);
      }
      if (!name || !email) {
        return json({ error: 'Name and email are required.' }, 400, corsHeaders);
      }

      try {
        await sendContactEmail(env, { name, phone, email, message });
        return json({ success: true }, 200, corsHeaders);
      } catch (err) {
        return json({ error: err.message }, 500, corsHeaders);
      }
    }

    return json({ error: 'Not found' }, 404, corsHeaders);
  },
};

// ── Google helpers ────────────────────────────────────────────────────────────

async function getAccessToken(env) {
  if (!env.GOOGLE_REFRESH_TOKEN) {
    throw new Error('Calendar not authorized yet. Visit /oauth/start to authorize.');
  }
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_REFRESH_TOKEN,
      grant_type:    'refresh_token',
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || 'Failed to get access token');
  return data.access_token;
}

async function getAvailableSlots(accessToken) {
  const now = new Date();
  const end = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);

  const freeBusyRes = await fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      timeMin:  now.toISOString(),
      timeMax:  end.toISOString(),
      timeZone: 'America/Denver',
      items:    [{ id: 'primary' }],
    }),
  });

  const freeBusy = await freeBusyRes.json();
  const busy = freeBusy.calendars?.primary?.busy || [];

  // Candidate slots: Mon–Fri, 9am–4pm hourly MT (MDT = UTC-6)
  // 30-min call duration, 24-hour minimum advance notice
  const CALL_DURATION_MS = 30 * 60 * 1000;
  const MIN_NOTICE_MS    = 24 * 60 * 60 * 1000;
  const slots = [];
  const slotHours = [9, 10, 11, 12, 13, 14, 15, 16];
  const cursor = new Date(now);
  cursor.setMinutes(0, 0, 0);

  while (slots.length < 20 && cursor < end) {
    const day = cursor.getDay();
    if (day >= 1 && day <= 5) {
      for (const hour of slotHours) {
        const slotStart = new Date(cursor);
        slotStart.setHours(hour + 6, 0, 0, 0); // MDT → UTC
        const slotEnd = new Date(slotStart.getTime() + CALL_DURATION_MS);

        // Skip if within 24-hour window
        if (slotStart.getTime() - now.getTime() < MIN_NOTICE_MS) continue;

        const isBusy = busy.some(b => {
          const bStart = new Date(b.start);
          const bEnd   = new Date(b.end);
          return slotStart < bEnd && slotEnd > bStart;
        });

        if (!isBusy) {
          slots.push({
            start:    slotStart.toISOString(),
            end:      slotEnd.toISOString(),
            duration: 30,
            label: slotStart.toLocaleString('en-US', {
              weekday: 'short', month: 'short', day: 'numeric',
              hour: 'numeric', minute: '2-digit',
              timeZone: 'America/Denver', timeZoneName: 'short',
            }),
          });
        }
        if (slots.length >= 20) break;
      }
    }
    cursor.setDate(cursor.getDate() + 1);
  }

  return slots;
}

async function bookSlot(accessToken, { name, email, slot }) {
  const start = new Date(slot);
  const end   = new Date(start.getTime() + 30 * 60 * 1000); // 30-minute call

  const eventRes = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      summary:     `Discovery Call — ${name}`,
      description: `New website client\nName: ${name}\nEmail: ${email}`,
      start: { dateTime: start.toISOString(), timeZone: 'America/Denver' },
      end:   { dateTime: end.toISOString(),   timeZone: 'America/Denver' },
      attendees: [{ email }],
      conferenceData: {
        createRequest: {
          requestId: `tjs-${Date.now()}`,
          conferenceSolutionKey: { type: 'hangoutsMeet' },
        },
      },
      reminders: {
        useDefault: false,
        overrides: [
          { method: 'email',  minutes: 60 },
          { method: 'popup',  minutes: 15 },
        ],
      },
    }),
  });

  const event = await eventRes.json();
  if (!eventRes.ok) throw new Error(event.error?.message || 'Failed to book event');
  return event;
}

// ── Prospect-call helpers (schedule.html) ────────────────────────────────────

async function getProspectSlots(accessToken) {
  const now = new Date();
  const end = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);

  const freeBusyRes = await fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      timeMin:  now.toISOString(),
      timeMax:  end.toISOString(),
      timeZone: 'America/Denver',
      items:    [{ id: 'primary' }],
    }),
  });

  const freeBusy = await freeBusyRes.json();
  const busy = freeBusy.calendars?.primary?.busy || [];

  const CALL_DURATION_MS = 15 * 60 * 1000;  // 15-minute calls
  const MIN_NOTICE_MS    = 24 * 60 * 60 * 1000;
  const slots = [];
  // Mon–Fri, 9 am – 4:30 pm MDT (UTC-6), slots on the hour and half-hour
  const slotHours   = [9, 10, 11, 12, 13, 14, 15, 16];
  const slotMinutes = [0, 30];

  const cursor = new Date(now);
  cursor.setMinutes(0, 0, 0);

  outer:
  while (cursor < end) {
    const day = cursor.getDay(); // UTC day-of-week — close enough for MDT
    if (day >= 1 && day <= 5) {
      for (const hour of slotHours) {
        for (const minute of slotMinutes) {
          // Skip 4:30 pm start → would end 4:45 pm, fine; but skip 5:00 pm+
          if (hour === 16 && minute === 30) continue;

          const slotStart = new Date(cursor);
          slotStart.setHours(hour + 6, minute, 0, 0); // MDT (UTC-6) → UTC
          const slotEnd = new Date(slotStart.getTime() + CALL_DURATION_MS);

          if (slotStart.getTime() - now.getTime() < MIN_NOTICE_MS) continue;

          const isBusy = busy.some(b => {
            const bStart = new Date(b.start);
            const bEnd   = new Date(b.end);
            return slotStart < bEnd && slotEnd > bStart;
          });

          if (!isBusy) {
            const dateStr = slotStart.toLocaleDateString('en-US', {
              weekday: 'long', month: 'long', day: 'numeric',
              timeZone: 'America/Denver',
            });
            const startT = slotStart.toLocaleTimeString('en-US', {
              hour: 'numeric', minute: '2-digit',
              timeZone: 'America/Denver',
            });
            const endT = slotEnd.toLocaleTimeString('en-US', {
              hour: 'numeric', minute: '2-digit',
              timeZone: 'America/Denver', timeZoneName: 'short',
            });
            slots.push({
              start: slotStart.toISOString(),
              date:  dateStr,
              time:  `${startT} – ${endT}`,
            });
          }
          if (slots.length >= 20) break outer;
        }
      }
    }
    cursor.setDate(cursor.getDate() + 1);
  }

  return slots;
}

async function bookProspectSlot(accessToken, { name, email, phone, biz, note, slot }) {
  const start = new Date(slot);
  const end   = new Date(start.getTime() + 15 * 60 * 1000);

  const descLines = [
    '📞 Prospect call — Trevor calls them.',
    '',
    `Phone:    ${phone || '—'}`,
    `Email:    ${email}`,
    `Business: ${biz || '—'}`,
  ];
  if (note) descLines.push(`Note:     ${note}`);
  descLines.push('', 'Booked via tjsdesign.online/schedule');

  const eventRes = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      summary:     `Prospect Call — ${name}${biz ? ' · ' + biz : ''}`,
      description: descLines.join('\n'),
      start: { dateTime: start.toISOString(), timeZone: 'America/Denver' },
      end:   { dateTime: end.toISOString(),   timeZone: 'America/Denver' },
      attendees: [{ email }],
      // No conferenceData block — this is a phone call, Trevor dials out
      reminders: {
        useDefault: false,
        overrides: [
          { method: 'email',  minutes: 24 * 60 },
          { method: 'popup',  minutes: 15 },
        ],
      },
    }),
  });

  const event = await eventRes.json();
  if (!eventRes.ok) throw new Error(event.error?.message || 'Failed to book event');
  return event;
}

async function sendProspectBookingEmail(env, { name, phone, email, biz, note, slotDate, slotTime }) {
  if (!env.RESEND_API_KEY) throw new Error('Missing RESEND_API_KEY');

  const lines = [
    '📞 New prospect call booked!',
    '',
    `Name:     ${name}`,
    `Business: ${biz || '—'}`,
    `Phone:    ${phone || '—'}`,
    `Email:    ${email}`,
    `When:     ${slotDate || ''}${slotTime ? ' at ' + slotTime : ''}`,
  ];
  if (note) lines.push(`Note:     ${note}`);
  lines.push('', "You're calling them — their number is above. The event is on your Google Calendar.");

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from:     'TJS Design <onboarding@resend.dev>',
      to:       'trevorspencer89@gmail.com',
      reply_to: email,
      subject:  `Prospect call booked — ${name}${slotDate ? ' · ' + slotDate : ''}`,
      text:     lines.join('\n'),
    }),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.message || 'Failed to send notification email.');
  return data;
}

// ── Stripe helpers ───────────────────────────────────────────────────────────

const STRIPE_API = 'https://api.stripe.com/v1';
const STRIPE_HEADERS = (env) => ({
  'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
  'Content-Type': 'application/x-www-form-urlencoded',
  'Stripe-Version': '2024-06-20',
});

async function stripeCreateCustomer(env, { name, email }) {
  const res = await fetch(`${STRIPE_API}/customers`, {
    method: 'POST',
    headers: STRIPE_HEADERS(env),
    body: new URLSearchParams({ name, email }),
  });
  const customer = await res.json();
  if (!res.ok) throw new Error(customer.error?.message || 'Could not create customer.');
  return customer;
}

async function stripeCreateSubscription(env, { customer, monthlyPrice, upfrontPrice, name, email, plan, agreedAt, ip }) {
  const params = new URLSearchParams({
    customer,
    'items[0][price]': monthlyPrice,
    payment_behavior: 'default_incomplete',
    'payment_settings[save_default_payment_method]': 'on_subscription',
    'expand[]': 'latest_invoice.payment_intent',
    description: `TJS Design — ${PLANS[plan].label} plan (12-month agreement)`,
    'metadata[plan]': plan,
    'metadata[customer_name]': name,
    'metadata[customer_email]': email,
    'metadata[agreement]': `${YEAR_ONE_PAYMENTS}-month agreement accepted at checkout`,
    'metadata[agreed_at]': agreedAt,
    'metadata[agreed_ip]': ip,
    'metadata[terms_version]': TERMS_VERSION,
  });
  if (upfrontPrice) params.set('add_invoice_items[0][price]', upfrontPrice);
  const res = await fetch(`${STRIPE_API}/subscriptions`, {
    method: 'POST',
    headers: STRIPE_HEADERS(env),
    body: params,
  });
  const sub = await res.json();
  if (!res.ok) throw new Error(sub.error?.message || 'Could not create subscription.');
  return sub;
}

async function stripeGet(env, path) {
  const res = await fetch(`${STRIPE_API}${path}`, { headers: STRIPE_HEADERS(env) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `Stripe GET ${path} failed.`);
  return data;
}
async function stripePost(env, path, params) {
  const res = await fetch(`${STRIPE_API}${path}`, { method: 'POST', headers: STRIPE_HEADERS(env), body: params });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `Stripe POST ${path} failed.`);
  return data;
}

/**
 * Turn a freshly paid year-one subscription into a schedule:
 *   phase 1 — the plan's monthly price for 12 billing periods (the 12-month agreement)
 *   phase 2 — Essential Care month-to-month, then the schedule releases and the
 *             subscription simply continues at $29.99/mo until the client cancels.
 * Safe to call more than once: does nothing if the subscription already has a schedule.
 */
async function ensureContractSchedule(env, subscriptionId) {
  const sub = await stripeGet(env, `/subscriptions/${subscriptionId}`);
  if (sub.schedule) return 'Schedule already set';
  if (sub.status !== 'active' && sub.status !== 'trialing') return `Not scheduled yet (subscription is ${sub.status})`;
  const plan = PLANS[sub.metadata?.plan];
  if (!plan) return 'Not scheduled (no plan on subscription)';

  const ids = await priceIds(env);
  const sched = await stripePost(env, '/subscription_schedules', new URLSearchParams({ from_subscription: subscriptionId }));
  const p0 = sched.phases[0];
  await stripePost(env, `/subscription_schedules/${sched.id}`, new URLSearchParams({
    end_behavior: 'release',
    proration_behavior: 'none',
    'phases[0][items][0][price]': ids[plan.monthly],
    'phases[0][items][0][quantity]': '1',
    'phases[0][start_date]': String(p0.start_date),
    'phases[0][iterations]': String(YEAR_ONE_PAYMENTS),
    'phases[0][proration_behavior]': 'none',
    'phases[1][items][0][price]': ids[AFTER_YEAR_ONE],
    'phases[1][items][0][quantity]': '1',
    'phases[1][iterations]': '1',
    'phases[1][proration_behavior]': 'none',
    'metadata[plan]': sub.metadata.plan,
    'metadata[note]': '12 year-one payments, then Essential Care month-to-month',
  }));
  return `Schedule ${sched.id} set: ${YEAR_ONE_PAYMENTS} × ${plan.label} payments, then Essential Care $29.99/mo`;
}

/** Verify a Stripe webhook signature (t=…,v1=…) with HMAC-SHA256. */
async function verifyStripeSignature(payload, header, secret) {
  if (!secret || !header) return false;
  const parts = Object.fromEntries(header.split(',').map(kv => kv.split('=')));
  const sigs = header.split(',').filter(kv => kv.startsWith('v1=')).map(kv => kv.slice(3));
  if (!parts.t || !sigs.length) return false;
  if (Math.abs(Date.now() / 1000 - Number(parts.t)) > 600) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${parts.t}.${payload}`));
  const hex = [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, '0')).join('');
  return sigs.some(s => s.length === hex.length && [...s].every((c, i) => c === hex[i]));
}

// ── Resend helpers ──────────────────────────────────────────────────────────

async function sendPaymentNotificationEmail(env, { name, email, plan, subscriptionId, scheduleNote }) {
  if (!env.RESEND_API_KEY) {
    throw new Error('Payment notification not sent (missing RESEND_API_KEY).');
  }

  const cfg = PLANS[plan];
  const purchase = cfg
    ? `${cfg.label} plan — ${cfg.upfrontCents ? '$' + (cfg.upfrontCents / 100).toFixed(2) + ' upfront + ' : ''}$${(cfg.monthlyCents / 100).toFixed(2)}/mo, 12-month agreement`
    : `Unknown plan (${plan || 'none'})`;

  const lines = [
    'Payment received from a new client!',
    '',
    `Name: ${name}`,
    `Email: ${email}`,
    `Purchase: ${purchase}`,
  ];
  if (subscriptionId) lines.push(`Stripe Subscription ID: ${subscriptionId}`);
  if (scheduleNote) lines.push(`12-month schedule: ${scheduleNote}`);
  lines.push(
    '',
    "They should be scheduling their intake call next. If you don't see a calendar booking from them soon, it's worth reaching out directly."
  );

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'TJS Design Checkout <onboarding@resend.dev>',
      to: 'trevorspencer89@gmail.com',
      reply_to: email,
      subject: `New payment received — ${name}`,
      text: lines.join('\n'),
    }),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.message || 'Failed to send payment notification email.');
  return data;
}

async function sendContactEmail(env, { name, phone, email, message }) {
  if (!env.RESEND_API_KEY) {
    throw new Error('Contact form is not configured yet (missing RESEND_API_KEY).');
  }

  const isSchedule = message && message.startsWith('SCHEDULE REQUEST');
  const subject = isSchedule
    ? `Schedule request — ${name}`
    : `New contact form submission — ${name}`;
  const body = message
    ? message
    : `New message from the TJS Design site contact form:\n\nName: ${name}\nPhone: ${phone || '—'}\nEmail: ${email}`;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'TJS Design Contact Form <onboarding@resend.dev>',
      to: 'trevorspencer89@gmail.com',
      reply_to: email,
      subject,
      text: body,
    }),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.message || 'Failed to send email.');
  return data;
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}
