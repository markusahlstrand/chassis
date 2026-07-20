/**
 * Callout (the FSM demo vertical) as a deployable Cloudflare Worker.
 *
 * This is the same vertical the pure-SQLite demo runs, deployed onto the
 * Durable-Object adapter: one `ScopeDO` per scope (kernel + engines + the
 * Callout module bundled in), a durable `ControlPlaneDO` directory, and a thin
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
  z,
} from '@substrat-run/contracts';
import { defineScopeDO, ControlPlaneDO, CloudflareScopeHost } from '@substrat-run/adapter-cloudflare';
import {
  assertPlatformCall,
  PlatformCallError,
  readRoutedNode,
  RouterAssertionError,
} from '@substrat-run/kernel';
import { provisionCallout } from './provision.js';
import { ControlPlaneClient, ControlPlaneError } from '@substrat-run/control-plane-api';
import { workorderModule, PERM as WO } from '@substrat-run/engine-workorder';
import { invoicingModule, INVOICING_PERM as INV } from '@substrat-run/engine-invoicing';
import { protocolModule, PROTOCOL_PERM as PROTO } from '@substrat-run/engine-protocol';
import { calloutModule, SC_PERM } from './module.js';
import { buildAuth, type Auth } from './auth.js';
import { mountApi } from './routes.js';
import {
  betterAuthAdapter,
  devHeaderAdapter,
  resolvePrincipal,
  PERSONAS,
  TECHNICIAN_ROLE,
  type AuthAdapter,
  type DemoNode,
} from './auth-adapters.js';

// Registration order is a migration-ordering contract (protocol before callout).
const MODULES = [workorderModule, invoicingModule, protocolModule, calloutModule];

/** The scope-DO class = the app binary: kernel + engines + Callout, bundled. */
export const ScopeDO = defineScopeDO(MODULES, {});
export { ControlPlaneDO };

// Fixed demo identifiers (valid ULIDs). One tenant, one scope; Anna is the
// office admin, Harald a scoped technician (fill/report, no signing).
const T = tenantId.parse('01JZ0000000000000000000001');
const S = scopeId.parse('01JZ0000000000000000000002');
const ANNA = principalId.parse('01JZ0000000000000000000003');
const HARALD = principalId.parse('01JZ0000000000000000000004');
const STAFF = platformActorId.parse('01JZ0000000000000000000005');
/**
 * The demo world's node. This is what `/api/seed` provisions and what a standalone
 * deploy serves — it is NO LONGER what a request is assumed to be for. Behind the
 * router the node comes from the resolved hostname, which is what makes one
 * deployment able to serve many tenants (K-26).
 */
const DEMO_NODE: DemoNode = { tenantId: T, scopeId: S };

/** Persona key → the fixed principal its Better Auth login binds to (in /api/seed). */
const PERSONA_PRINCIPAL = { anna: ANNA, harald: HARALD } as const;

interface Env {
  SCOPE: DurableObjectNamespace;
  CONTROL_PLANE: DurableObjectNamespace;
  AUTH_DB: D1Database;
  /** Static-asset server for the built SPA (./app/dist), bound in wrangler.jsonc. */
  ASSETS: Fetcher;
  BETTER_AUTH_SECRET?: string;
  BASE_URL?: string;
  /** Local dev only: when 'true', trust the `x-principal` header. NEVER set in prod. */
  ALLOW_DEV_HEADER?: string;
  /**
   * Shared secret the router presents (K-26). When set, a request that does not
   * carry it cannot assert a tenant — so a vertical worker that is publicly
   * reachable by accident still cannot be told which tenant to serve.
   */
  ROUTER_SECRET?: string;
  /**
   * Shared secret the CONTROL PLANE presents to provision an instance here (K-31).
   *
   * Separate from ROUTER_SECRET because they are different authorities: the router
   * may say which tenant a request is for, and must not be able to create one. Unset
   * means provisioning is refused entirely — an unconfigured template must not
   * provision for strangers.
   */
  PLATFORM_SECRET?: string;
  /**
   * Serve ONLY the demo world, with no router in front. This is the pre-router
   * deployment shape, kept because it is genuinely useful — `wrangler dev` and a
   * single-tenant demo box both want it.
   *
   * Deliberately NOT folded into `ALLOW_DEV_HEADER`: that flag lets any caller be
   * any principal, and someone who merely wants a standalone deploy should not have
   * to switch on impersonation to get it.
   */
  STANDALONE?: string;
  /**
   * Connected mode (first-flow.md slice 4): when set, this vertical registers its
   * tenant/scope into a SEPARATELY-deployed shared control plane and gates every
   * request on its lifecycle — so a suspend in that control plane's console fails
   * this vertical's next request closed. `SERVICE_TOKEN` authenticates the vertical
   * to the control plane as a service (not staff). Unset → the embedded control
   * plane is the only authority (self-contained).
   */
  CONTROL_PLANE_URL?: string;
  SERVICE_TOKEN?: string;
  /**
   * Service binding to the control-plane worker. Worker-to-worker calls MUST go
   * through this, not a public same-zone URL (Cloudflare blocks that). Absent
   * locally, where the client uses the URL over plain fetch.
   */
  CONTROL_PLANE_SVC?: Fetcher;
}

/** A client for the shared control plane, or undefined when self-contained. */
function cpClientFor(env: Env): ControlPlaneClient | undefined {
  if (!env.CONTROL_PLANE_URL) return undefined;
  const svc = env.CONTROL_PLANE_SVC;
  return new ControlPlaneClient({
    baseUrl: env.CONTROL_PLANE_URL,
    actor: STAFF, // sent, but the control plane authenticates via the service token
    serviceToken: env.SERVICE_TOKEN,
    // Route through the service binding when deployed; plain fetch locally.
    fetch: svc ? svc.fetch.bind(svc) : undefined,
  });
}

/**
 * Which tenant/scope this request is for.
 *
 * Behind the router: whatever the hostname resolved to. Standalone: the demo world.
 * Neither: refuse — an unrouted request in a multi-tenant deployment has no defensible
 * default, and picking one would mean serving somebody else's data.
 */
function nodeFor(req: Request, env: Env): DemoNode {
  let routed;
  try {
    routed = readRoutedNode(req.headers, { expectedSecret: env.ROUTER_SECRET });
  } catch (e) {
    if (e instanceof RouterAssertionError) throw new HTTPException(400, { message: e.message });
    throw e;
  }
  if (routed) return { tenantId: routed.tenantId, scopeId: routed.scopeId };
  if (env.STANDALONE === 'true') return DEMO_NODE;
  throw new HTTPException(503, {
    message: 'no scope was asserted for this request (missing router, or set STANDALONE=true)',
  });
}

/** The coordinator is stateless — rebuilt per request; durable state is in the DOs. */
function hostFor(env: Env): CloudflareScopeHost {
  const host = new CloudflareScopeHost({ scope: env.SCOPE, controlPlane: env.CONTROL_PLANE });
  for (const m of MODULES) host.registerModule(m);
  return host;
}

/** The request's own origin — Better Auth trusts it as baseURL, so login works on
 * any deployment (localhost, *.workers.dev, custom domain) with no config. */
const originOf = (req: Request): string => new URL(req.url).origin;

/**
 * The mounted auth seam: Better Auth (session cookie). The kernel only ever
 * receives the resolved `PrincipalId`. The `x-principal` dev-header adapter is
 * an impersonation bypass by design, so it is mounted ONLY when
 * `ALLOW_DEV_HEADER=true` (local dev) — secure by default, off in production.
 */
function authFor(
  env: Env,
  origin: string,
  node: DemoNode,
): { auth: Auth; host: CloudflareScopeHost; adapters: AuthAdapter[] } {
  const auth = buildAuth(env, origin);
  const host = hostFor(env);
  const adapters: AuthAdapter[] = [betterAuthAdapter(auth, host, node)];
  if (env.ALLOW_DEV_HEADER === 'true') adapters.push(devHeaderAdapter(node));
  return { auth, host, adapters };
}

/**
 * Parse, don't trust — even from the platform. A malformed id reaching the kernel is
 * a worse failure than a rejected call, and this is the one entry point where the
 * caller is not a session we already resolved.
 */
const provisionInstanceBody = z.object({
  tenantId,
  scopeId,
  owner: principalId,
  slug: z.string().min(1),
  name: z.string().min(1),
});

const app = new Hono<{ Bindings: Env }>();

// Edge authentication (M3): Better Auth owns identity/credentials/sessions in
// D1, mounted under /api/auth/*. A per-request instance (stateless coordinator).
app.on(['GET', 'POST'], '/api/auth/*', (c) => buildAuth(c.env, originOf(c.req.raw)).handler(c.req.raw));

/**
 * Provision ONE instance of this vertical, on the platform's instruction (K-31).
 *
 * The control plane decides an instance should exist and calls this, because only the
 * vertical can create a usable scope DO — the DO class bundles the modules and lives
 * in this deployment. The platform cannot do it on the vertical's behalf.
 *
 * Deliberately NOT under `/api/*`: that prefix is the tenant-facing surface behind the
 * router, and this is a platform-to-vertical call that must never be reachable from a
 * tenant's session. It is authenticated by the platform secret alone — no principal,
 * no scope, because at this moment neither exists yet.
 *
 * Idempotent, so a retried call after a partial failure converges rather than
 * duplicating. That matters more than usual here: K-31 makes this the second phase of a
 * two-phase creation, and the reconciliation sweep re-runs exactly this.
 */
app.post('/internal/provision', async (c) => {
  try {
    assertPlatformCall(c.req.raw.headers, { expectedSecret: c.env.PLATFORM_SECRET });
  } catch (e) {
    if (e instanceof PlatformCallError) throw new HTTPException(403, { message: e.message });
    throw e;
  }

  const body = provisionInstanceBody.parse(await c.req.json());
  const instance = await provisionCallout(hostFor(c.env), body);
  return c.json(instance, 201);
});

// One-time (idempotent) provisioning of the demo world.
app.post('/api/seed', async (c) => {
  const host = hostFor(c.env);
  await host.admin.createTenant(STAFF, { id: T, slug: 'elmontage', name: 'ElMontage AB' });
  for (const key of ['workorder', 'invoicing', 'protocol', 'callout']) {
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
  const auth = buildAuth(c.env, originOf(c.req.raw));
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

  // Connected mode: mirror this tenant/scope into the shared control plane so the
  // portal sees the live vertical. Idempotent; the gate below enforces lifecycle.
  const cp = cpClientFor(c.env);
  if (cp) {
    await cp.createTenant({ id: T, slug: 'elmontage', name: 'ElMontage AB' });
    for (const key of ['workorder', 'invoicing', 'protocol', 'callout']) {
      await cp.grantEntitlement(T, key);
    }
    await cp.provisionScope({
      tenantId: T,
      scopeId: S,
      slug: 'huvudkontor',
      kind: 'branch',
      name: 'ElMontage — Huvudkontor',
      vertical: 'fsm',
      jurisdiction: 'eu',
    });
  }
  return c.json({ seeded: true, tenant: T, scope: S, principal: ANNA, logins, connected: !!cp });
});

// A protected data route resolves the caller across the mounted adapters, then
// getScope for the fixed demo tenant/scope. No adapter matched → 401 (fail closed).
async function stub(c: { env: Env; req: { raw: Request } }) {
  const node = nodeFor(c.req.raw, c.env);
  const { host, adapters } = authFor(c.env, originOf(c.req.raw), node);
  const result = await resolvePrincipal(adapters, c.req.raw.headers);
  if (!result) throw new HTTPException(401, { message: 'unauthorized' });
  // Connected mode: gate on the shared control plane's lifecycle. A suspend in the
  // portal fails this request closed, across the deployment boundary.
  const cp = cpClientFor(c.env);
  if (cp) {
    try {
      await cp.assertScopeActive(result.tenantId, result.scopeId);
    } catch (e) {
      throw new HTTPException(403, { message: e instanceof ControlPlaneError ? e.message : String(e) });
    }
  }
  return host.getScope(result.principal, result.tenantId, result.scopeId);
}

// The resolved identity behind the current request (principal, display, role), or 401.
app.get('/api/me', async (c) => {
  const { adapters } = authFor(c.env, originOf(c.req.raw), nodeFor(c.req.raw, c.env));
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

// The whole data API — the SAME route table the node server mounts (src/routes.ts),
// which also installs the shared fail-closed error handler. Here the stub
// authenticates via Better Auth on the Durable-Object adapter.
mountApi(app, stub);

// Serve the built SPA (./app/dist) for everything that isn't an /api/* route.
// This MUST come after all API routes so Hono handles /api/* (especially
// /api/auth/*) first; the catch-all then delegates to the ASSETS binding, which
// returns index.html for unknown client routes (SPA fallback). Single origin →
// Better Auth's session cookie is same-origin, no CORS.
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
