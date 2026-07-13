import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { principalId, type PrincipalId } from '@substrat/contracts';
import { PermissionDenied, type ScopeStub } from '@substrat/kernel';
import { buildDemoHost, seedDemo, type DemoWorld } from './index.js';

/**
 * Dev API server for the FSM demo (stage 4 of the E2E run). Deliberately
 * thin: authenticate (dev principal picker via x-principal header) →
 * getScope → invoke. Every route is a wrapper over an operation; there is no
 * business logic here. The platform-grade surface (zod-openapi, sessions,
 * authhero) replaces the auth stub later without touching anything below.
 */

const dataDir = join(dirname(fileURLToPath(import.meta.url)), '..', '.data');
mkdirSync(dataDir, { recursive: true });

const host = buildDemoHost(dataDir);
const world: DemoWorld = await seedDemo(host, dataDir);

const CAST: Record<string, { name: string; role: string; principal: PrincipalId }> = {
  anna: { name: 'Anna (kontor)', role: 'office-admin', principal: world.anna },
  harald: { name: 'Harald (tekniker)', role: 'technician', principal: world.harald },
  berit: { name: 'Berit (portal, BRF Grunden)', role: 'portal', principal: world.berit },
  styrbjorn: {
    name: 'Styrbjörn (portal, Kontorshotellet)',
    role: 'portal',
    principal: world.styrbjorn,
  },
  mallory: { name: 'Mallory (annan firma!)', role: 'attacker', principal: world.mallory },
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

app.get('/api/customers', async (c) => c.json(await (await stub(c)).invoke('serviceco/list-customers')));
app.get('/api/prices', async (c) => c.json(await (await stub(c)).invoke('serviceco/price-list')));

app.get('/api/workorders', async (c) =>
  c.json(await (await stub(c)).invoke('workorder/list', { status: c.req.query('status') })),
);
app.post('/api/workorders', async (c) =>
  c.json(await (await stub(c)).invoke('serviceco/create-workorder', await c.req.json())),
);
app.get('/api/workorders/:id', async (c) =>
  c.json(await (await stub(c)).invoke('workorder/get', { orderId: c.req.param('id') })),
);
app.get('/api/workorders/:id/timeline', async (c) =>
  c.json(
    await (await stub(c)).invoke('serviceco/timeline', {
      entityType: 'workorder',
      entityId: c.req.param('id'),
    }),
  ),
);
app.post('/api/workorders/:id/assign', async (c) =>
  c.json(
    await (await stub(c)).invoke('workorder/assign', {
      orderId: c.req.param('id'),
      ...(await c.req.json<Record<string, unknown>>()),
    }),
  ),
);
app.post('/api/workorders/:id/start', async (c) =>
  c.json(await (await stub(c)).invoke('workorder/start', { orderId: c.req.param('id') })),
);
app.post('/api/workorders/:id/time', async (c) =>
  c.json(
    await (await stub(c)).invoke('workorder/report-time', {
      orderId: c.req.param('id'),
      ...(await c.req.json<Record<string, unknown>>()),
    }),
  ),
);
app.post('/api/workorders/:id/material', async (c) =>
  c.json(
    await (await stub(c)).invoke('workorder/report-material', {
      orderId: c.req.param('id'),
      ...(await c.req.json<Record<string, unknown>>()),
    }),
  ),
);
app.post('/api/workorders/:id/complete', async (c) =>
  c.json(
    await (await stub(c)).invoke('serviceco/complete-workorder', { orderId: c.req.param('id') }),
  ),
);
app.post('/api/workorders/:id/close', async (c) =>
  c.json(await (await stub(c)).invoke('workorder/close', { orderId: c.req.param('id') })),
);

app.get('/api/portal/orders', async (c) =>
  c.json(await (await stub(c)).invoke('serviceco/portal-orders')),
);

app.get('/api/invoicing', async (c) => c.json(await (await stub(c)).invoke('invoicing/list')));
app.get('/api/invoicing/:id', async (c) =>
  c.json(await (await stub(c)).invoke('invoicing/get', { underlagId: c.req.param('id') })),
);
app.post('/api/invoicing/:id/export', async (c) =>
  c.json(await (await stub(c)).invoke('invoicing/export', { underlagId: c.req.param('id') })),
);

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port });
console.log(`FSM demo API on http://localhost:${port} — data in ${dataDir}`);
