import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { PermissionDenied, type ScopeStub } from '@substrat-run/kernel';
import type { PrincipalId, ScopeId, TenantId } from '@substrat-run/contracts';
import { buildDemoHost, seedDemo, type DemoWorld } from './index.js';

/**
 * Dev API server for the PeopleCo demo. Deliberately thin: pick the dev
 * principal from the `x-principal` header → getScope → invoke. No business
 * logic here; every route is a wrapper over an operation, and the kernel
 * enforces the permission on every op regardless of how the route reached it.
 *
 * There is no Better Auth here yet — this is the local demo harness. The
 * `x-principal` picker is an impersonation bypass by design, fine for a
 * localhost dev server, never a production posture.
 */

const dataDir = join(dirname(fileURLToPath(import.meta.url)), '..', '.data');
mkdirSync(dataDir, { recursive: true });

// Dev ports in the private 887x/527x block. The employee app is :5275, the
// (future) admin web app :5276, both proxying /api to this server on :8875.
const PORT = Number(process.env.PORT ?? 8875);
const WEB_PORT = Number(process.env.WEB_PORT ?? 5275);

const host = buildDemoHost(dataDir);
const world: DemoWorld = await seedDemo(host, dataDir);

interface Persona {
  key: string;
  display: string;
  role: string;
  country: 'SE' | 'ES';
  principal: PrincipalId;
  tenantId: TenantId;
  scopeId: ScopeId;
  employeeId: string | null;
}

const CAST: Persona[] = [
  { key: 'elin', display: 'Elin Ek', role: 'employee', country: 'SE', principal: world.elin, tenantId: world.t1, scopeId: world.sSe, employeeId: world.elinEmpId },
  { key: 'pablo', display: 'Pablo Ruiz', role: 'employee', country: 'ES', principal: world.pablo, tenantId: world.t1, scopeId: world.sEs, employeeId: world.pabloEmpId },
  { key: 'mats', display: 'Mats Lund (team lead)', role: 'manager', country: 'SE', principal: world.mats, tenantId: world.t1, scopeId: world.sSe, employeeId: world.matsEmpId },
  { key: 'hedda', display: 'Hedda (HR admin)', role: 'hr-admin', country: 'SE', principal: world.hedda, tenantId: world.t1, scopeId: world.sSe, employeeId: null },
  { key: 'petra', display: 'Petra (payroll)', role: 'payroll', country: 'SE', principal: world.petra, tenantId: world.t1, scopeId: world.sSe, employeeId: null },
  { key: 'mallory', display: 'Mallory (other company!)', role: 'attacker', country: 'SE', principal: world.mallory, tenantId: world.t2, scopeId: world.s2, employeeId: null },
];

function persona(c: Context): Persona {
  const key = c.req.header('x-principal') ?? 'elin';
  return CAST.find((p) => p.key === key) ?? CAST[0]!;
}
async function stub(c: Context): Promise<ScopeStub> {
  const p = persona(c);
  return host.getScope(p.principal, p.tenantId, p.scopeId);
}

const app = new Hono();

app.onError((err, c) => {
  if (err instanceof PermissionDenied) return c.json({ error: err.message }, 403);
  const m = err instanceof Error ? err.message : String(err);
  if (/permission denied/.test(m)) return c.json({ error: m }, 403);
  if (/not found|unknown scope/.test(m)) return c.json({ error: m }, 404);
  return c.json({ error: m }, 400);
});

// The dev persona picker + "who am I" — the app switches personas by setting the
// x-principal header. employeeId is what an employee app centres itself on.
app.get('/api/cast', (c) =>
  c.json(CAST.map(({ key, display, role, country, employeeId }) => ({ key, display, role, country, employeeId }))),
);
app.get('/api/me', (c) => {
  const p = persona(c);
  return c.json({ key: p.key, display: p.display, role: p.role, country: p.country, employeeId: p.employeeId });
});

// Generic invoke: the kernel checks permissions inside every operation, so a
// generic route is exactly as safe as 18 explicit ones — and far less code.
app.post('/api/invoke', async (c) => {
  const { op, input } = await c.req.json<{ op: string; input?: unknown }>();
  return c.json((await (await stub(c)).invoke(op, input)) ?? null);
});

serve({ fetch: app.fetch, port: PORT });
console.log(`\n  PeopleCo (HR) demo API  http://localhost:${PORT}`);
console.log(`  employee app            http://localhost:${WEB_PORT}`);
console.log(`  data                    ${dataDir}\n`);
