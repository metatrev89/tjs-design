/**
 * TJS Design — Checkout Worker
 * Creates Stripe Payment Intents server-side so card data never touches GitHub Pages.
 * Qualifies the site for PCI DSS SAQ A (simplest compliance tier).
 *
 * Environment secrets (set in Cloudflare dashboard → Worker → Settings → Variables):
 *   STRIPE_SECRET_KEY  — sk_live_... (never expose this in frontend code)
 *
 * Routes:
 *   POST /create-payment-intent  →  { clientSecret: "pi_...secret..." }
 */

const ALLOWED_ORIGINS = [
  'https://metatrev89.github.io',
  'http://localhost',
  'http://127.0.0.1',
];

const CORS = (origin) => ({
  'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
});

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const corsHeaders = CORS(origin);

    // Handle preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    const url = new URL(request.url);

    // ── POST /create-payment-intent ──────────────────────────────────────────
    if (url.pathname === '/create-payment-intent') {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: 'Invalid JSON' }, 400, corsHeaders);
      }

      const { name, email, addon, addonBilling } = body;

      if (!name || !email) {
        return json({ error: 'Name and email are required.' }, 400, corsHeaders);
      }

      // Calculate amount in cents
      // Base: $999.99 website build (one-time)
      // Addon annual: $999.96/yr billed today ($83.33/mo × 12)
      // Addon monthly: $129.99/mo billed today
      let amountCents = 99999;
      if (addon) {
        amountCents += addonBilling === 'annual' ? 99996 : 12999;
      }

      // Build a human-readable description for the Stripe dashboard
      let description = 'TJS Design — Custom Website Build';
      if (addon) {
        description += addonBilling === 'annual'
          ? ' + Site Management (Annual)'
          : ' + Site Management (Monthly)';
      }

      // Create the Payment Intent via Stripe API
      const stripeRes = await fetch('https://api.stripe.com/v1/payment_intents', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Stripe-Version': '2024-06-20',
        },
        body: new URLSearchParams({
          amount: String(amountCents),
          currency: 'usd',
          description,
          receipt_email: email,
          'metadata[customer_name]': name,
          'metadata[customer_email]': email,
          'metadata[addon]': addon ? 'true' : 'false',
          'metadata[addon_billing]': addonBilling || 'none',
          // automatic_payment_methods enables cards + Apple/Google Pay
          'automatic_payment_methods[enabled]': 'true',
        }),
      });

      const pi = await stripeRes.json();

      if (!stripeRes.ok) {
        console.error('Stripe error:', pi);
        return json({ error: pi.error?.message || 'Payment setup failed.' }, 400, corsHeaders);
      }

      return json({ clientSecret: pi.client_secret }, 200, corsHeaders);
    }

    return json({ error: 'Not found' }, 404, corsHeaders);
  },
};

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}
