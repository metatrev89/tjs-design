/**
 * TJS Design — Checkout Worker
 * Handles Stripe payments + subscriptions + Google Calendar booking + contact form
 *
 * Environment secrets (Cloudflare Worker Settings → Variables):
 *   STRIPE_SECRET_KEY      — sk_live_...
 *   GOOGLE_CLIENT_ID       — OAuth client ID
 *   GOOGLE_CLIENT_SECRET   — OAuth client secret
 *   GOOGLE_REFRESH_TOKEN   — set after running /oauth/start once
 *   RESEND_API_KEY         — Resend API key, used to email contact form submissions
 *
 * Routes:
 *   GET  /oauth/start             →  redirect to Google consent screen
 *   GET  /oauth/callback          →  exchange code, display refresh token
 *   GET  /calendar/slots          →  return available booking slots
 *   POST /calendar/book           →  create calendar event
 *   POST /create-payment-intent   →  { clientSecret } — one-time build, or a real Stripe
 *                                     Subscription (Site Management) with the build billed
 *                                     once on the first invoice. See PRICE_IDS below.
 *   POST /contact                 →  email a footer contact-form submission via Resend
 */

// Stripe Products/Prices created 2026-06-20 — acct_1T488BA7Unp9hIDT (live mode).
// Product "Custom Website Build" (prod_UjxHRuqBTYwmpH) and
// Product "Site Management" (prod_UjxH80uDsyyRex).
const PRICE_IDS = {
  build:   'price_1TkTNCA7Unp9hIDT9WnyLcjA', // Custom Website Build — $999.99 one-time
  monthly: 'price_1TkTNNA7Unp9hIDTZiLloBNF', // Site Management — $129.99/month
  annual:  'price_1TkTNTA7Unp9hIDTVLhCUom3', // Site Management — $999.96/year
};

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

    // ── POST /create-payment-intent ───────────────────────────────────────
    if (url.pathname === '/create-payment-intent' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch {
        return json({ error: 'Invalid JSON' }, 400, corsHeaders);
      }

      const { name, email, addon, addonBilling } = body;
      if (!name || !email) {
        return json({ error: 'Name and email are required.' }, 400, corsHeaders);
      }

      try {
        if (!addon) {
          // Build only — simple one-time PaymentIntent, no subscription involved.
          const pi = await stripeCreatePaymentIntent(env, {
            amount: 99999,
            description: 'TJS Design — Custom Website Build',
            email, name,
          });
          return json({ clientSecret: pi.client_secret }, 200, corsHeaders);
        }

        // Build + Site Management — create a real recurring Subscription.
        // The Website Build is billed once, on this first invoice only, via
        // add_invoice_items; the Subscription itself then auto-renews going
        // forward at the Site Management price (monthly or annual).
        const managementPrice = addonBilling === 'annual' ? PRICE_IDS.annual : PRICE_IDS.monthly;

        const customer = await stripeCreateCustomer(env, { name, email });
        const sub = await stripeCreateSubscription(env, {
          customer: customer.id,
          managementPrice,
          buildPrice: PRICE_IDS.build,
          name, email, addonBilling,
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

    // ── POST /contact ──────────────────────────────────────────────────────
    if (url.pathname === '/contact' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch {
        return json({ error: 'Invalid JSON' }, 400, corsHeaders);
      }

      const { name, phone, email, company } = body;
      // Honeypot: real visitors never fill this hidden field — bots often do.
      if (company) {
        return json({ success: true }, 200, corsHeaders);
      }
      if (!name || !email) {
        return json({ error: 'Name and email are required.' }, 400, corsHeaders);
      }

      try {
        await sendContactEmail(env, { name, phone, email });
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

// ── Stripe helpers ───────────────────────────────────────────────────────────

const STRIPE_API = 'https://api.stripe.com/v1';
const STRIPE_HEADERS = (env) => ({
  'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
  'Content-Type': 'application/x-www-form-urlencoded',
  'Stripe-Version': '2024-06-20',
});

async function stripeCreatePaymentIntent(env, { amount, description, email, name }) {
  const res = await fetch(`${STRIPE_API}/payment_intents`, {
    method: 'POST',
    headers: STRIPE_HEADERS(env),
    body: new URLSearchParams({
      amount: String(amount),
      currency: 'usd',
      description,
      receipt_email: email,
      'metadata[customer_name]': name,
      'metadata[customer_email]': email,
      'metadata[price_id]': PRICE_IDS.build,
      'automatic_payment_methods[enabled]': 'true',
    }),
  });
  const pi = await res.json();
  if (!res.ok) throw new Error(pi.error?.message || 'Payment setup failed.');
  return pi;
}

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

async function stripeCreateSubscription(env, { customer, managementPrice, buildPrice, name, email, addonBilling }) {
  const params = new URLSearchParams({
    customer,
    'items[0][price]': managementPrice,
    'add_invoice_items[0][price]': buildPrice,
    payment_behavior: 'default_incomplete',
    'payment_settings[save_default_payment_method]': 'on_subscription',
    'expand[]': 'latest_invoice.payment_intent',
    'metadata[customer_name]': name,
    'metadata[customer_email]': email,
    'metadata[addon_billing]': addonBilling || 'none',
  });
  const res = await fetch(`${STRIPE_API}/subscriptions`, {
    method: 'POST',
    headers: STRIPE_HEADERS(env),
    body: params,
  });
  const sub = await res.json();
  if (!res.ok) throw new Error(sub.error?.message || 'Could not create subscription.');
  return sub;
}

// ── Resend helper ───────────────────────────────────────────────────────────

async function sendContactEmail(env, { name, phone, email }) {
  if (!env.RESEND_API_KEY) {
    throw new Error('Contact form is not configured yet (missing RESEND_API_KEY).');
  }

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
      subject: `New contact form submission — ${name}`,
      text: `New message from the TJS Design site contact form:\n\nName: ${name}\nPhone: ${phone || '—'}\nEmail: ${email}`,
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
