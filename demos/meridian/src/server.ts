import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import type { Context } from 'hono';
import Database from 'better-sqlite3';
import { PermissionDenied, ulid, type ScopeStub } from '@substrat-run/kernel';
import { buildAuthNode, migrateAuth } from './auth-node.js';
import {
  devHeaderAdapter,
  resolvePrincipal,
  type AuthAdapter,
} from './auth-adapters.js';
import { platformActorId, type PrincipalId, type ScopeId, type TenantId } from '@substrat-run/contracts';
import { buildDemoHost, seedDemo, type DemoWorld } from './index.js';

/**
 * Dev API server for the Meridian demo. Deliberately thin: pick the dev
 * principal from the `x-principal` header → getScope → invoke. No business
 * logic here; every route is a wrapper over an operation, and the kernel
 * enforces the permission on every op regardless of how the route reached it.
 *
 * There is no Better Auth here yet. The `x-principal` picker is an
 * impersonation bypass by design — anyone naming a persona becomes it — so it is
 * mounted ONLY when ALLOW_DEV_HEADER=true, matching Callout's posture.
 *
 * Secure by default matters more here than it did as a demo: this is a template
 * now (D-33), and a template is COPIED. A default that impersonates is one people
 * carry into production without noticing they opted into anything.
 */

const dataDir = join(dirname(fileURLToPath(import.meta.url)), '..', '.data');
mkdirSync(dataDir, { recursive: true });

// Dev ports in the private 887x/527x block. The employee app is :5275, the
// (future) admin web app :5276, both proxying /api to this server on :8875.
const PORT = Number(process.env.PORT ?? 8875);
const WEB_PORT = Number(process.env.WEB_PORT ?? 5275);

const host = buildDemoHost(dataDir);
const world: DemoWorld = await seedDemo(host, dataDir);

const auth = buildAuthNode(dataDir, `http://localhost:${PORT}`, [
  `http://localhost:${PORT}`,
  `http://localhost:${WEB_PORT}`,
]);
await migrateAuth(auth);

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
  { key: 'elin', display: 'Elin Ek', role: 'employee', country: 'SE', principal: world.elin, tenantId: world.t1, scopeId: world.sSe, employeeId: world.elinEmpId ?? null },
  { key: 'pablo', display: 'Pablo Ruiz', role: 'employee', country: 'ES', principal: world.pablo, tenantId: world.t1, scopeId: world.sEs, employeeId: world.pabloEmpId ?? null },
  { key: 'mats', display: 'Mats Lund (team lead)', role: 'manager', country: 'SE', principal: world.mats, tenantId: world.t1, scopeId: world.sSe, employeeId: world.matsEmpId ?? null },
  { key: 'hedda', display: 'Hedda (HR admin)', role: 'hr-admin', country: 'SE', principal: world.hedda, tenantId: world.t1, scopeId: world.sSe, employeeId: null },
  { key: 'petra', display: 'Petra (payroll)', role: 'payroll', country: 'SE', principal: world.petra, tenantId: world.t1, scopeId: world.sSe, employeeId: null },
  { key: 'mallory', display: 'Mallory (other company!)', role: 'attacker', country: 'SE', principal: world.mallory, tenantId: world.t2, scopeId: world.s2, employeeId: null },
];

/**
 * Real auth first; the dev header only if explicitly opted in.
 *
 * A template teaches by example, so the example is a session — not a header that
 * names whoever it likes. The header stays for local iteration and stays OFF by
 * default, because a copied template inherits its defaults.
 *
 * Meridian's personas each carry their own (tenant, scope) — there is a second
 * company for the cross-tenant beat — so resolution walks the cast to find whose
 * principal a session maps to. A login unknown to every company resolves to
 * nobody, and reads the same as unauthenticated.
 */
const adapters: AuthAdapter[] = [];
if (process.env.ALLOW_DEV_HEADER === 'true') adapters.push(devHeaderAdapter());

async function persona(c: Context): Promise<Persona> {
  const headers = c.req.raw.headers;
  const session = await sessionPersona(headers);
  if (session) return session;

  const viaAdapters = await resolvePrincipal(adapters, headers);
  if (viaAdapters) {
    const found = CAST.find((p) => p.principal === viaAdapters.principal);
    if (found) return found;
  }
  // The dev header may also name a persona KEY, which is what the app's picker
  // sends. Kept because it is the ergonomic half of the demo, and gated with the
  // rest of the header.
  if (process.env.ALLOW_DEV_HEADER === 'true') {
    const key = headers.get('x-principal');
    const byKey = key ? CAST.find((p) => p.key === key) : undefined;
    if (byKey) return byKey;
  }
  throw new PermissionDenied('not authenticated');
}

/** A Better Auth session → the persona that login is bound to, in whichever company. */
async function sessionPersona(headers: Headers): Promise<Persona | null> {
  const s = await auth.api.getSession({ headers });
  if (!s?.user) return null;
  for (const p of CAST) {
    const mapped = await host.admin.resolveIdentity(p.tenantId, 'better-auth', s.user.id);
    if (mapped && mapped.principal === p.principal) return p;
  }
  return null;
}

async function stub(c: Context): Promise<ScopeStub> {
  const p = await persona(c);
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
app.get('/api/me', async (c) => {
  const p = await persona(c);
  return c.json({ key: p.key, display: p.display, role: p.role, country: p.country, employeeId: p.employeeId });
});

// Generic invoke: the kernel checks permissions inside every operation, so a
// generic route is exactly as safe as 18 explicit ones — and far less code.
app.post('/api/invoke', async (c) => {
  const { op, input } = await c.req.json<{ op: string; input?: unknown }>();
  return c.json((await (await stub(c)).invoke(op, input)) ?? null);
});

// Better Auth owns /api/auth/*. Mounted last so it cannot shadow a demo route.
app.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw));

await seedPersonaLogins();

serve({ fetch: app.fetch, port: PORT });
console.log(`\n  Meridian (HR) demo API  http://localhost:${PORT}`);
console.log(`  employee app            http://localhost:${WEB_PORT}`);
console.log(`  data                    ${dataDir}\n`);

/**
 * Demo logins for the cast, so the template runs with a real session out of the
 * box rather than only with the dev header.
 *
 * Idempotent on both sides: sign-up throws when the email exists, in which case
 * the id is read back, and an already-linked identity is skipped. The two stores
 * have independent lifecycles, so neither may assume the other is empty.
 */
async function seedPersonaLogins(): Promise<void> {
  const staff = platformActorId.parse(ulid());
  const db = new Database(join(dataDir, 'better-auth.sqlite'), { readonly: true });
  try {
    for (const p of CAST) {
      const email = `${p.key}@meridian.test`;
      let externalId: string | undefined;
      try {
        externalId = (
          await auth.api.signUpEmail({
            body: { email, password: 'meridian-demo', name: p.display },
          })
        ).user.id;
      } catch {
        externalId = (db.prepare('SELECT id FROM user WHERE email = ?').get(email) as
          | { id: string }
          | undefined)?.id;
      }
      if (!externalId) continue;
      if (await host.admin.resolveIdentity(p.tenantId, 'better-auth', externalId)) continue;
      await host.admin.linkIdentity(staff, {
        provider: 'better-auth',
        externalId,
        principal: p.principal,
        tenantId: p.tenantId,
        scopeId: p.scopeId,
      });
    }
  } finally {
    db.close();
  }
}
