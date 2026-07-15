import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { type PrincipalId } from '@substrat-run/contracts';
import { PermissionDenied, type ScopeStub } from '@substrat-run/kernel';
import { buildShopHost, seedShop, type ShopWorld } from './index.js';
import { buildAuth, migrateAuth } from './auth.js';
import {
  betterAuthAdapter,
  devPickerAuth,
  resolvePrincipal,
  type AuthAdapter,
  type AuthResult,
} from './auth-adapters.js';

/**
 * Dev API server for the Kallkälla Kaffe demo. Deliberately thin: authenticate
 * (dev principal picker via x-principal header) → getScope → invoke. Every route
 * is a wrapper over an operation; there is no business logic here.
 */

const dataDir = join(dirname(fileURLToPath(import.meta.url)), '..', '.data');
mkdirSync(dataDir, { recursive: true });

const PORT = Number(process.env.PORT ?? 8789);
const WEB_ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:5175';

const host = buildShopHost(dataDir);
const world: ShopWorld = await seedShop(host, dataDir);

// Better Auth — its own store, migrated on startup (the "second adapter").
const auth = buildAuth(dataDir, PORT, WEB_ORIGIN);
await migrateAuth(auth);

const CAST: Record<string, { name: string; role: string; principal: PrincipalId; customerId?: string }> = {
  astrid: { name: 'Astrid (butiksägare)', role: 'shop-admin', principal: world.astrid },
  gustav: { name: 'Gustav (lager)', role: 'warehouse', principal: world.gustav },
  elin: { name: 'Elin (Café Pascal)', role: 'shopper', principal: world.elin, customerId: world.elinCustomerId },
  otto: { name: 'Otto (Kontoret)', role: 'shopper', principal: world.otto, customerId: world.ottoCustomerId },
  guest: { name: 'Gäst (anonym)', role: 'shopper', principal: world.guest },
  rurik: { name: 'Rurik (Bönfeber!)', role: 'attacker', principal: world.rurik },
};

// Mounted auth adapters, in precedence order: a real Better Auth session wins
// over a dev-picker header. Chosen by config so you can run one, the other, or both.
const ENABLED = (process.env.AUTH ?? 'better-auth,dev').split(',').map((s) => s.trim());
const adapters: AuthAdapter[] = [];
if (ENABLED.includes('better-auth')) adapters.push(betterAuthAdapter(auth, host, world));
if (ENABLED.includes('dev')) adapters.push(devPickerAuth(world, CAST));

const app = new Hono();

async function resolve(c: Context): Promise<AuthResult> {
  const r = await resolvePrincipal(adapters, c.req.raw.headers);
  if (!r) throw new PermissionDenied('not authenticated');
  return r;
}
async function stub(c: Context): Promise<ScopeStub> {
  const r = await resolve(c);
  return host.getScope(r.principal, r.tenantId, r.scopeId);
}
async function body(c: Context): Promise<Record<string, unknown>> {
  return c.req.json<Record<string, unknown>>();
}

// Better Auth owns everything under /api/auth/* (sign-up, sign-in, session, …).
app.on(['POST', 'GET'], '/api/auth/*', (c) => auth.handler(c.req.raw));

// Who am I right now (either door), and my customer id for checkout.
app.get('/api/me', async (c) => {
  const r = await resolvePrincipal(adapters, c.req.raw.headers);
  if (!r) return c.json({ authenticated: false });
  let customerId: string | null = null;
  try {
    const s = await host.getScope(r.principal, r.tenantId, r.scopeId);
    customerId = (await s.invoke<{ id: string } | null>('shop/my-customer'))?.id ?? null;
  } catch {
    customerId = null;
  }
  return c.json({ authenticated: true, principal: r.principal, display: r.display, via: r.via, customerId });
});

app.onError((err, c) => {
  if (err instanceof PermissionDenied) return c.json({ error: err.message }, 403);
  if (/permission denied/.test(err.message)) return c.json({ error: err.message }, 403);
  if (/not found|unknown scope/.test(err.message)) return c.json({ error: err.message }, 404);
  if (/out of stock/.test(err.message)) return c.json({ error: err.message }, 409);
  return c.json({ error: err.message }, 400);
});

app.get('/api/cast', (c) => c.json({ cast: CAST, world: { customers: { elin: world.elinCustomerId, otto: world.ottoCustomerId } } }));

// storefront
app.get('/api/catalog', async (c) => c.json(await (await stub(c)).invoke('shop/catalog')));
app.post('/api/carts', async (c) => c.json(await (await stub(c)).invoke('shop/create-cart')));
app.get('/api/carts/:id', async (c) => c.json(await (await stub(c)).invoke('shop/cart', { cartId: c.req.param('id') })));
app.post('/api/carts/:id/lines', async (c) =>
  c.json(await (await stub(c)).invoke('shop/add-to-cart', { ...(await body(c)), cartId: c.req.param('id') })),
);
app.patch('/api/carts/:id/lines/:lineId', async (c) =>
  c.json(
    await (await stub(c)).invoke('shop/set-line-qty', {
      ...(await body(c)),
      cartId: c.req.param('id'),
      lineId: c.req.param('lineId'),
    }),
  ),
);
app.delete('/api/carts/:id/lines/:lineId', async (c) =>
  c.json(await (await stub(c)).invoke('shop/remove-line', { cartId: c.req.param('id'), lineId: c.req.param('lineId') })),
);
app.post('/api/carts/:id/quote', async (c) =>
  c.json(await (await stub(c)).invoke('shop/quote', { ...(await body(c)), cartId: c.req.param('id') })),
);
app.post('/api/carts/:id/checkout', async (c) =>
  c.json(await (await stub(c)).invoke('shop/checkout', { ...(await body(c)), cartId: c.req.param('id') })),
);

// portal
app.get('/api/portal/orders', async (c) => c.json(await (await stub(c)).invoke('shop/portal-orders')));

// admin — catalogue
app.post('/api/products', async (c) => c.json(await (await stub(c)).invoke('shop/create-product', await body(c))));
app.post('/api/products/:id/variants', async (c) =>
  c.json(await (await stub(c)).invoke('shop/add-variant', { ...(await body(c)), productId: c.req.param('id') })),
);
app.post('/api/products/:id/publish', async (c) =>
  c.json(await (await stub(c)).invoke('shop/publish-product', { ...(await body(c)), productId: c.req.param('id') })),
);
app.post('/api/variants/:id/stock', async (c) =>
  c.json(await (await stub(c)).invoke('shop/set-stock', { ...(await body(c)), variantId: c.req.param('id') })),
);
app.post('/api/discounts', async (c) => c.json(await (await stub(c)).invoke('shop/create-discount', await body(c))));
app.post('/api/customers', async (c) => c.json(await (await stub(c)).invoke('shop/create-customer', await body(c))));

// admin — orders
app.get('/api/orders', async (c) => c.json(await (await stub(c)).invoke('shop/orders')));
app.get('/api/orders/:id', async (c) => c.json(await (await stub(c)).invoke('shop/order', { orderId: c.req.param('id') })));
app.post('/api/orders/:id/fulfil', async (c) => c.json(await (await stub(c)).invoke('shop/fulfil-order', { orderId: c.req.param('id') })));
app.post('/api/orders/:id/close', async (c) => c.json(await (await stub(c)).invoke('shop/close-order', { orderId: c.req.param('id') })));

// invoicing (reused engine)
app.get('/api/invoicing', async (c) => c.json(await (await stub(c)).invoke('invoicing/list')));
app.get('/api/invoicing/:id', async (c) => c.json(await (await stub(c)).invoke('invoicing/get', { underlagId: c.req.param('id') })));
app.post('/api/invoicing/:id/export', async (c) => c.json(await (await stub(c)).invoke('invoicing/export', { underlagId: c.req.param('id') })));

serve({ fetch: app.fetch, port: PORT });
console.log(`Kallkälla shop demo API on http://localhost:${PORT} — data in ${dataDir}`);
console.log(`  auth adapters: ${adapters.map((a) => a.id).join(', ')}`);
