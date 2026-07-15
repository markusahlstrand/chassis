/**
 * ServiceCo (the FSM demo vertical) as a deployable Cloudflare Worker.
 *
 * This is the same vertical the pure-SQLite demo runs, deployed onto the
 * Durable-Object adapter: one `ScopeDO` per scope (kernel + engines + the
 * ServiceCo module bundled in), a durable `ControlPlaneDO` directory, and a thin
 * Hono API that authenticates → getScope → invoke. Proof that a vertical runs on
 * the real Cloudflare runtime with every kernel guarantee below the API surface.
 *
 * Local run:  wrangler dev            (real workerd, no account)
 * Deploy:     wrangler deploy         (needs a Workers Paid plan — DO SQLite)
 */
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import {
  principalId,
  scopeId,
  tenantId,
  platformActorId,
} from '@substrat-run/contracts';
import { defineScopeDO, ControlPlaneDO, CloudflareScopeHost } from '@substrat-run/adapter-cloudflare';
import { workorderModule, PERM as WO } from '@substrat-run/engine-workorder';
import { invoicingModule, INVOICING_PERM as INV } from '@substrat-run/engine-invoicing';
import { protocolModule, PROTOCOL_PERM as PROTO } from '@substrat-run/engine-protocol';
import { servicecoModule, SC_PERM } from './module.js';
import { buildAuth, type Auth } from './auth.js';
import {
  betterAuthAdapter,
  devHeaderAdapter,
  resolvePrincipal,
  PERSONAS,
  TECHNICIAN_ROLE,
  type AuthAdapter,
  type DemoNode,
} from './auth-adapters.js';

// Registration order is a migration-ordering contract (protocol before serviceco).
const MODULES = [workorderModule, invoicingModule, protocolModule, servicecoModule];

/** The scope-DO class = the app binary: kernel + engines + ServiceCo, bundled. */
export const ScopeDO = defineScopeDO(MODULES, {});
export { ControlPlaneDO };

// Fixed demo identifiers (valid ULIDs). One tenant, one scope; Anna is the
// office admin, Harald a scoped technician (fill/report, no signing).
const T = tenantId.parse('01JZ0000000000000000000001');
const S = scopeId.parse('01JZ0000000000000000000002');
const ANNA = principalId.parse('01JZ0000000000000000000003');
const HARALD = principalId.parse('01JZ0000000000000000000004');
const STAFF = platformActorId.parse('01JZ0000000000000000000005');
const NODE: DemoNode = { tenantId: T, scopeId: S };

/** Persona key → the fixed principal its Better Auth login binds to (in /api/seed). */
const PERSONA_PRINCIPAL = { anna: ANNA, harald: HARALD } as const;

interface Env {
  SCOPE: DurableObjectNamespace;
  CONTROL_PLANE: DurableObjectNamespace;
  AUTH_DB: D1Database;
  BETTER_AUTH_SECRET?: string;
  BASE_URL?: string;
  /** Local dev only: when 'true', trust the `x-principal` header. NEVER set in prod. */
  ALLOW_DEV_HEADER?: string;
}

/** The coordinator is stateless — rebuilt per request; durable state is in the DOs. */
function hostFor(env: Env): CloudflareScopeHost {
  const host = new CloudflareScopeHost({ scope: env.SCOPE, controlPlane: env.CONTROL_PLANE });
  for (const m of MODULES) host.registerModule(m);
  return host;
}

/**
 * The mounted auth seam: Better Auth (session cookie). The kernel only ever
 * receives the resolved `PrincipalId`. The `x-principal` dev-header adapter is
 * an impersonation bypass by design, so it is mounted ONLY when
 * `ALLOW_DEV_HEADER=true` (local dev) — secure by default, off in production.
 */
function authFor(env: Env): { auth: Auth; host: CloudflareScopeHost; adapters: AuthAdapter[] } {
  const auth = buildAuth(env);
  const host = hostFor(env);
  const adapters: AuthAdapter[] = [betterAuthAdapter(auth, host, NODE)];
  if (env.ALLOW_DEV_HEADER === 'true') adapters.push(devHeaderAdapter(NODE));
  return { auth, host, adapters };
}

const app = new Hono<{ Bindings: Env }>();

// Edge authentication (M3): Better Auth owns identity/credentials/sessions in
// D1, mounted under /api/auth/*. A per-request instance (stateless coordinator).
app.on(['GET', 'POST'], '/api/auth/*', (c) => buildAuth(c.env).handler(c.req.raw));

app.get('/', (c) =>
  c.json({
    ok: true,
    vertical: 'ServiceCo (fsm) on Cloudflare Durable Objects',
    hint: 'POST /api/seed once, then GET/POST /api/customers and /api/workorders',
  }),
);

// One-time (idempotent) provisioning of the demo world.
app.post('/api/seed', async (c) => {
  const host = hostFor(c.env);
  await host.admin.createTenant(STAFF, { id: T, slug: 'elmontage', name: 'ElMontage AB' });
  for (const key of ['workorder', 'invoicing', 'protocol', 'serviceco']) {
    await host.admin.grantEntitlement(STAFF, T, key);
  }
  await host.provisionScope(STAFF, { tenantId: T, scopeId: S, jurisdiction: 'eu' });
  await host.admin.defineRole(STAFF, T, {
    key: 'office-admin',
    permissions: [
      SC_PERM.customerManage, SC_PERM.facilityManage,
      WO.create, WO.read, WO.assign, WO.report, WO.complete, WO.close,
      INV.read, INV.export,
      PROTO.create, PROTO.fill, PROTO.sign, PROTO.read, PROTO.void,
    ],
    source: 'vertical',
  });
  await host.admin.assignRole(STAFF, {
    principalId: ANNA,
    roleKey: 'office-admin',
    node: { tenantId: T, scopeId: null },
  });
  // Technicians fill protocols and report on jobs; SIGNING stays with the office.
  await host.admin.defineRole(STAFF, T, TECHNICIAN_ROLE);
  await host.admin.assignRole(STAFF, {
    principalId: HARALD,
    roleKey: 'technician',
    node: { tenantId: T, scopeId: S },
  });

  // Seed a Better Auth login for each persona and bind it to that persona's
  // fixed principal through the neutral identity seam (idempotent). Logging in
  // *is* that principal — the kernel enforces exactly its permissions.
  const auth = buildAuth(c.env);
  const logins: Record<string, string> = {};
  for (const p of PERSONAS) {
    let userId: string | undefined;
    try {
      const res = await auth.api.signUpEmail({ body: { email: p.email, password: p.password, name: p.name } });
      userId = res.user.id;
    } catch {
      // Already exists — read the id back from Better Auth's own D1 store.
      const row = (await c.env.AUTH_DB.prepare('SELECT id FROM user WHERE email = ?')
        .bind(p.email)
        .first()) as { id: string } | null;
      userId = row?.id;
    }
    if (userId) {
      await host.admin.linkIdentity(STAFF, {
        provider: 'better-auth',
        externalId: userId,
        principal: PERSONA_PRINCIPAL[p.key],
        tenantId: T,
        scopeId: S,
      });
      logins[p.email] = p.role;
    }
  }
  return c.json({ seeded: true, tenant: T, scope: S, principal: ANNA, logins });
});

// A protected data route resolves the caller across the mounted adapters, then
// getScope for the fixed demo tenant/scope. No adapter matched → 401 (fail closed).
async function stub(c: { env: Env; req: { raw: Request } }) {
  const { host, adapters } = authFor(c.env);
  const result = await resolvePrincipal(adapters, c.req.raw.headers);
  if (!result) throw new HTTPException(401, { message: 'unauthorized' });
  return host.getScope(result.principal, T, S);
}

// The resolved identity behind the current request (principal, display, role), or 401.
app.get('/api/me', async (c) => {
  const { adapters } = authFor(c.env);
  const result = await resolvePrincipal(adapters, c.req.raw.headers);
  if (!result) return c.json({ error: 'unauthorized' }, 401);
  return c.json({
    principal: result.principal,
    display: result.display,
    role: result.role,
    via: result.via,
    tenant: result.tenantId,
    scope: result.scopeId,
  });
});

app.get('/api/customers', async (c) => c.json(await (await stub(c)).invoke('serviceco/list-customers')));
app.post('/api/customers', async (c) =>
  c.json(await (await stub(c)).invoke('serviceco/create-customer', await c.req.json())),
);
app.post('/api/facilities', async (c) =>
  c.json(await (await stub(c)).invoke('serviceco/create-facility', await c.req.json())),
);
app.get('/api/prices', async (c) => c.json(await (await stub(c)).invoke('serviceco/price-list')));
app.post('/api/prices', async (c) =>
  c.json(await (await stub(c)).invoke('serviceco/upsert-price', await c.req.json())),
);
app.get('/api/workorders', async (c) =>
  c.json(await (await stub(c)).invoke('workorder/list', { status: c.req.query('status') })),
);
app.post('/api/workorders', async (c) =>
  c.json(await (await stub(c)).invoke('serviceco/create-workorder', await c.req.json())),
);
app.get('/api/workorders/:id', async (c) =>
  c.json(await (await stub(c)).invoke('workorder/get', { orderId: c.req.param('id') })),
);

// Fail closed → JSON. An unauthenticated request is a 401; a permission or
// invariant violation is a 4xx, not a 500.
app.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse();
  return c.json({ error: (err as Error).message }, 400);
});

export default app;
