import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { principalId, type PrincipalId } from '@substrat-run/contracts';
import { PermissionDenied, type ScopeStub } from '@substrat-run/kernel';
import { buildDemoHost, seedDemo, type DemoWorld } from './index.js';
import { mountApi } from './routes.js';

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

app.get('/api/cast', (c) => c.json(CAST));

// The whole data API — shared with the Cloudflare Worker (src/routes.ts). Here
// the stub authenticates via the x-principal dev picker on the SQLite adapter.
mountApi(app, stub);

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port });
console.log(`FSM demo API on http://localhost:${port} — data in ${dataDir}`);
