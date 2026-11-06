// Refined Life Co. checkout API (Cloudflare Worker)
// POST /api/checkout  { items: [{ id, q }] }  ->  { url }  (Stripe-hosted Checkout page)
// GET  /api/health    ->  shows whether the Stripe key and shipping rate are configured
//
// Prices come ONLY from catalog.json, never from the browser, so a visitor cannot change what they pay.
// If you change a price on the site, change it in catalog.json too.
//
// Settings (Cloudflare dashboard > Workers & Pages > refinedlife > Settings > Variables and Secrets):
//   STRIPE_SECRET_KEY       (Secret)  live key for real orders (rk_live_... restricted key recommended)
//   STRIPE_TEST_SECRET_KEY  (Secret)  sandbox key (rk_test_/sk_test_) used when the site sends {test:true}
//   SHIPPING_FLAT_CENTS     (wrangler.jsonc)  shipping on physical orders under $35, in cents (595 = $5.95)
//   LIVE_USES_CATALOG       (wrangler.jsonc)  "1" once the live Stripe account has the rlc_* products
//
// Each catalog item maps to a Stripe product with ID rlc_<site id> (see productId below). The sandbox
// always has them; the live account uses them once LIVE_USES_CATALOG is "1". The price charged still
// comes from catalog.json either way.

import CATALOG from './catalog.json';

const ALLOWED_ORIGINS = [
  'https://refinedlifeco.com',
  'http://refinedlifeco.com',
  'https://www.refinedlifeco.com',
  'http://www.refinedlifeco.com',
  'https://misscheriblackwell.github.io',
];
const DEFAULT_SITE = 'https://refinedlifeco.com';
const FREE_SHIPPING_CENTS = 3500;
const productId = (id) => 'rlc_' + id.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const keyMode = (k) => (!k ? 'missing' : /^(sk|rk)_live_/.test(k) ? 'live' : 'test');

function json(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json' },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const site = ALLOWED_ORIGINS.includes(origin) ? origin : DEFAULT_SITE;
    const cors = {
      'Access-Control-Allow-Origin': site,
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      Vary: 'Origin',
    };

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    if (url.pathname === '/api/health') {
      const ship = parseInt(env.SHIPPING_FLAT_CENTS, 10);
      return json(
        {
          ok: true,
          stripeKey: keyMode(env.STRIPE_SECRET_KEY),
          sandboxKey: keyMode(env.STRIPE_TEST_SECRET_KEY),
          liveUsesCatalog: env.LIVE_USES_CATALOG === '1',
          shippingFlatCents: Number.isFinite(ship) ? ship : 'missing',
          products: Object.keys(CATALOG).length,
        },
        200,
        cors,
      );
    }

    if (url.pathname !== '/api/checkout' || request.method !== 'POST') {
      return json({ error: 'Not found' }, 404, cors);
    }
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Something went wrong. Please refresh and try again.' }, 400, cors);
    }

    const sandbox = body?.test === true;
    const stripeKey = sandbox ? env.STRIPE_TEST_SECRET_KEY : env.STRIPE_SECRET_KEY;
    if (!stripeKey || (sandbox && keyMode(stripeKey) !== 'test')) {
      return json({ error: sandbox ? 'Sandbox checkout is not set up yet.' : 'Checkout is not set up yet. Please try again soon.' }, 503, cors);
    }
    const useCatalog = sandbox || env.LIVE_USES_CATALOG === '1';

    const items = Array.isArray(body?.items) ? body.items : [];
    if (!items.length || items.length > 50) return json({ error: 'Your cart is empty.' }, 400, cors);

    const lines = [];
    let subtotal = 0;
    let physical = false;
    let interval = null;
    for (const it of items) {
      const p = CATALOG[it?.id];
      const q = Math.floor(Number(it?.q));
      if (!p || !(q >= 1 && q <= 99)) {
        return json({ error: 'An item in your cart is no longer available. Please refresh and try again.' }, 400, cors);
      }
      if (p.interval) {
        if (interval && interval !== p.interval) {
          return json({ error: 'Weekly and monthly text plans need separate checkouts. Please keep one in your cart.' }, 400, cors);
        }
        interval = p.interval;
      }
      if (!p.digital) physical = true;
      subtotal += p.cents * q;
      lines.push({ id: it.id, p, q });
    }

    const f = new URLSearchParams();
    f.set('mode', interval ? 'subscription' : 'payment');
    const sb = sandbox ? '&sandbox=1' : '';
    f.set('success_url', `${site}/?checkout=success${sb}`);
    f.set('cancel_url', `${site}/?checkout=cancelled${sb}`);
    f.set('allow_promotion_codes', 'true');
    f.set('billing_address_collection', 'auto');

    let n = 0;
    const addLine = (name, cents, qty, recurring, product) => {
      const k = `line_items[${n++}]`;
      f.set(`${k}[quantity]`, String(qty));
      f.set(`${k}[price_data][currency]`, 'usd');
      f.set(`${k}[price_data][unit_amount]`, String(cents));
      if (product) f.set(`${k}[price_data][product]`, product);
      else f.set(`${k}[price_data][product_data][name]`, name);
      if (recurring) f.set(`${k}[price_data][recurring][interval]`, recurring);
    };
    for (const { id, p, q } of lines) addLine(p.name, p.cents, q, p.interval, useCatalog ? productId(id) : null);

    if (physical) {
      f.set('shipping_address_collection[allowed_countries][0]', 'US');
      if (subtotal < FREE_SHIPPING_CENTS) {
        const ship = parseInt(env.SHIPPING_FLAT_CENTS, 10);
        if (!(ship >= 0)) {
          return json({ error: 'Shipping is not set up yet. Please try again soon.' }, 503, cors);
        }
        if (ship > 0) addLine('Standard U.S. shipping', ship, 1, null);
      }
    }

    // Order summary for the Stripe dashboard (Stripe limits metadata values to 500 characters)
    f.set('metadata[cart]', lines.map((l) => `${l.id} x${l.q}`).join(', ').slice(0, 500));

    const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${stripeKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: f,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.url) {
      console.error('Stripe error', res.status, JSON.stringify(data.error || data));
      return json({ error: 'Checkout could not start. Please try again in a moment.' }, 502, cors);
    }
    return json({ url: data.url }, 200, cors);
  },
};
