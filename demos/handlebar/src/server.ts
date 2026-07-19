import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  platformActorId, principalId, type PrincipalId } from '@substrat-run/contracts';
import Database from 'better-sqlite3';
import { PermissionDenied, ulid, type ScopeStub } from '@substrat-run/kernel';
import { buildAuthNode, migrateAuth } from './auth-node.js';
import {
  betterAuthAdapter,
  devHeaderAdapter,
  resolvePrincipal,
  type AuthAdapter,
} from './auth-adapters.js';
import { buildBikeShopHost, seedBikeShop, type BikeShopWorld } from './index.js';

/**
 * Dev API server for the Handlebar demo. Deliberately thin: authenticate
 * (dev principal picker via x-principal header, gated on ALLOW_DEV_HEADER) →
 * getScope → invoke. Every
 * route is a wrapper over an operation; there is no business logic here.
 * Runs on :8872 so it can sit next to the Callout demo (:8871).
 */

const dataDir = join(dirname(fileURLToPath(import.meta.url)), '..', '.data');
mkdirSync(dataDir, { recursive: true });

const host = buildBikeShopHost(dataDir);
const world: BikeShopWorld = await seedBikeShop(host, dataDir);

const PORT = Number(process.env.PORT ?? 8872);
const WEB_PORT = Number(process.env.WEB_PORT ?? 5272);

const auth = buildAuthNode(dataDir, `http://localhost:${PORT}`, [
  `http://localhost:${PORT}`,
  `http://localhost:${WEB_PORT}`,
]);
await migrateAuth(auth);

const CAST: Record<string, { name: string; role: string; principal: PrincipalId }> = {
  greta: { name: 'Greta (verkstadschef)', role: 'workshop-admin', principal: world.greta },
  mans: { name: 'Måns (mekaniker)', role: 'mechanic', principal: world.mans },
  lisbeth: { name: 'Lisbeth (portal, Crescent)', role: 'portal', principal: world.lisbeth },
  otto: { name: 'Otto (portal, Bianchi)', role: 'portal', principal: world.otto },
  rutger: { name: 'Rutger (annan verkstad!)', role: 'attacker', principal: world.rutger },
};

const app = new Hono();

/**
 * Real auth first; the dev header only if explicitly opted in.
 *
 * A template teaches by example, so the example is a session. The header stays for
 * local iteration because it is genuinely useful, and stays OFF by default because
 * a copied template inherits its defaults.
 */
const NODE = { tenantId: world.t1, scopeId: world.s1 };
const adapters: AuthAdapter[] = [betterAuthAdapter(auth, host, NODE)];
if (process.env.ALLOW_DEV_HEADER === 'true') adapters.push(devHeaderAdapter());

async function principalOf(c: Context): Promise<PrincipalId> {
  const result = await resolvePrincipal(adapters, c.req.raw.headers);
  // Authenticated-but-unknown reads the same as unauthenticated: whether an email
  // belongs to this workshop is not a question an outsider gets answered.
  if (!result) throw new PermissionDenied('not authenticated');
  return result.principal;
}

async function stub(c: Context): Promise<ScopeStub> {
  return host.getScope(await principalOf(c), world.t1, world.s1);
}

app.onError((err, c) => {
  if (err instanceof PermissionDenied) return c.json({ error: err.message }, 403);
  if (/not found|unknown scope/.test(err.message)) return c.json({ error: err.message }, 404);
  return c.json({ error: err.message }, 400);
});

app.get('/api/cast', (c) => c.json(CAST));

app.get('/api/customers', async (c) => c.json(await (await stub(c)).invoke('bike-shop/list-customers')));
app.post('/api/customers', async (c) =>
  c.json(await (await stub(c)).invoke('bike-shop/create-customer', await c.req.json())),
);
app.post('/api/customers/:id/bikes', async (c) =>
  c.json(
    await (await stub(c)).invoke('bike-shop/register-bike', {
      customerId: c.req.param('id'),
      ...(await c.req.json<Record<string, unknown>>()),
    }),
  ),
);
app.get('/api/prices', async (c) => c.json(await (await stub(c)).invoke('bike-shop/price-list')));
app.post('/api/prices', async (c) =>
  c.json(await (await stub(c)).invoke('bike-shop/upsert-price', await c.req.json())),
);

app.get('/api/repairs', async (c) =>
  c.json(await (await stub(c)).invoke('workorder/list', { status: c.req.query('status') })),
);
app.post('/api/repairs', async (c) =>
  c.json(await (await stub(c)).invoke('bike-shop/create-repair', await c.req.json())),
);
app.get('/api/repairs/:id', async (c) =>
  c.json(await (await stub(c)).invoke('workorder/get', { orderId: c.req.param('id') })),
);
app.get('/api/repairs/:id/timeline', async (c) =>
  c.json(
    await (await stub(c)).invoke('bike-shop/timeline', {
      entityType: 'workorder',
      entityId: c.req.param('id'),
    }),
  ),
);
app.post('/api/repairs/:id/assign', async (c) =>
  c.json(
    await (await stub(c)).invoke('workorder/assign', {
      orderId: c.req.param('id'),
      ...(await c.req.json<Record<string, unknown>>()),
    }),
  ),
);
app.post('/api/repairs/:id/start', async (c) =>
  c.json(await (await stub(c)).invoke('workorder/start', { orderId: c.req.param('id') })),
);
app.post('/api/repairs/:id/time', async (c) =>
  c.json(
    await (await stub(c)).invoke('workorder/report-time', {
      orderId: c.req.param('id'),
      ...(await c.req.json<Record<string, unknown>>()),
    }),
  ),
);
app.post('/api/repairs/:id/material', async (c) =>
  c.json(
    await (await stub(c)).invoke('workorder/report-material', {
      orderId: c.req.param('id'),
      ...(await c.req.json<Record<string, unknown>>()),
    }),
  ),
);
app.post('/api/repairs/:id/complete', async (c) =>
  c.json(await (await stub(c)).invoke('bike-shop/complete-repair', { orderId: c.req.param('id') })),
);
// Pickup — the only door to `closed`. The engine's `workorder/close` binding is
// withdrawn in the bike-shop manifest, and this operation is guarded: the kernel
// refuses it until the customer has counter-signed the tillståndsrapport.
app.post('/api/repairs/:id/close', async (c) =>
  c.json(await (await stub(c)).invoke('bike-shop/close-repair', { orderId: c.req.param('id') })),
);

app.get('/api/protocol-templates', async (c) =>
  c.json(await (await stub(c)).invoke('protocol/list-templates')),
);
app.get('/api/repairs/:id/protocols', async (c) =>
  c.json(
    await (await stub(c)).invoke('protocol/list-for-entity', {
      entityType: 'workorder',
      entityId: c.req.param('id'),
    }),
  ),
);
app.post('/api/repairs/:id/condition-report', async (c) =>
  c.json(
    await (await stub(c)).invoke('bike-shop/start-condition-report', {
      orderId: c.req.param('id'),
    }),
  ),
);
app.get('/api/protocols/:id', async (c) =>
  c.json(await (await stub(c)).invoke('protocol/get', { instanceId: c.req.param('id') })),
);
app.post('/api/protocols/:id/responses', async (c) =>
  c.json(
    await (await stub(c)).invoke('protocol/fill', {
      instanceId: c.req.param('id'),
      ...(await c.req.json<Record<string, unknown>>()),
    }),
  ),
);
app.post('/api/protocols/:id/sign', async (c) =>
  c.json(await (await stub(c)).invoke('protocol/sign', { instanceId: c.req.param('id') })),
);
app.post('/api/protocols/:id/countersign', async (c) =>
  c.json(await (await stub(c)).invoke('protocol/countersign', { instanceId: c.req.param('id') })),
);
app.post('/api/protocols/:id/void', async (c) =>
  c.json(
    await (await stub(c)).invoke('protocol/void', {
      instanceId: c.req.param('id'),
      ...(await c.req.json<Record<string, unknown>>()),
    }),
  ),
);

app.get('/api/portal/repairs', async (c) =>
  c.json(await (await stub(c)).invoke('bike-shop/portal-repairs')),
);

app.get('/api/invoicing', async (c) => c.json(await (await stub(c)).invoke('invoicing/list')));
app.get('/api/invoicing/:id', async (c) =>
  c.json(await (await stub(c)).invoke('invoicing/get', { underlagId: c.req.param('id') })),
);
app.post('/api/invoicing/:id/export', async (c) =>
  c.json(await (await stub(c)).invoke('invoicing/export', { underlagId: c.req.param('id') })),
);

// Better Auth owns /api/auth/*. Mounted last so it cannot shadow a demo route.
app.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw));

await seedPersonaLogins();

serve({ fetch: app.fetch, port: PORT });
console.log(`Handlebar demo API on http://localhost:${PORT} — data in ${dataDir}`);

/**
 * Demo logins for the cast, so the template runs with a real session out of the
 * box rather than only with the dev header.
 *
 * Idempotent on both sides: sign-up throws when the email exists, in which case
 * the id is read back, and an already-linked identity is skipped. The two stores
 * have independent lifecycles — the world may exist while Better Auth's tables are
 * fresh — so neither may assume the other is empty.
 */
async function seedPersonaLogins(): Promise<void> {
  const staff = platformActorId.parse(ulid());
  const db = new Database(join(dataDir, 'better-auth.sqlite'), { readonly: true });
  try {
    for (const [key, p] of Object.entries(CAST)) {
      const email = `${key}@handlebar.test`;
      let externalId: string | undefined;
      try {
        externalId = (
          await auth.api.signUpEmail({
            body: { email, password: 'handlebar-demo', name: p.name },
          })
        ).user.id;
      } catch {
        externalId = (db.prepare('SELECT id FROM user WHERE email = ?').get(email) as
          | { id: string }
          | undefined)?.id;
      }
      if (!externalId) continue;
      if (await host.admin.resolveIdentity(world.t1, 'better-auth', externalId)) continue;
      await host.admin.linkIdentity(staff, {
        provider: 'better-auth',
        externalId,
        principal: p.principal,
        tenantId: world.t1,
        scopeId: world.s1,
      });
    }
  } finally {
    db.close();
  }
}
