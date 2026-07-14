import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { principalId, type PrincipalId } from '@substrat-run/contracts';
import { PermissionDenied, type ScopeStub } from '@substrat-run/kernel';
import { buildBikeShopHost, seedBikeShop, type BikeShopWorld } from './index.js';

/**
 * Dev API server for the CykelService demo. Deliberately thin: authenticate
 * (dev principal picker via x-principal header) → getScope → invoke. Every
 * route is a wrapper over an operation; there is no business logic here.
 * Runs on :8788 so it can sit next to the ServiceCo demo (:8787).
 */

const dataDir = join(dirname(fileURLToPath(import.meta.url)), '..', '.data');
mkdirSync(dataDir, { recursive: true });

const host = buildBikeShopHost(dataDir);
const world: BikeShopWorld = await seedBikeShop(host, dataDir);

const CAST: Record<string, { name: string; role: string; principal: PrincipalId }> = {
  greta: { name: 'Greta (verkstadschef)', role: 'workshop-admin', principal: world.greta },
  mans: { name: 'Måns (mekaniker)', role: 'mechanic', principal: world.mans },
  lisbeth: { name: 'Lisbeth (portal, Crescent)', role: 'portal', principal: world.lisbeth },
  otto: { name: 'Otto (portal, Bianchi)', role: 'portal', principal: world.otto },
  rutger: { name: 'Rutger (annan verkstad!)', role: 'attacker', principal: world.rutger },
};

const app = new Hono();

function principalOf(c: Context): PrincipalId {
  const raw = c.req.header('x-principal');
  if (!raw) throw new PermissionDenied('missing x-principal header');
  return principalId.parse(raw);
}

async function stub(c: Context): Promise<ScopeStub> {
  return host.getScope(principalOf(c), world.t1, world.s1);
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
app.post('/api/repairs/:id/close', async (c) =>
  c.json(await (await stub(c)).invoke('workorder/close', { orderId: c.req.param('id') })),
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

const port = Number(process.env.PORT ?? 8788);
serve({ fetch: app.fetch, port });
console.log(`CykelService demo API on http://localhost:${port} — data in ${dataDir}`);
