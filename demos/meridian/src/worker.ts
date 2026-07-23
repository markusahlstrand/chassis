/**
 * Meridian (HR) vertical as a deployable Cloudflare Worker — SANDBOX-CLEAN and
 * control-plane-less (scope-local-permissions.md Phase 3), the shape a vertical must
 * have to be pushed into the Workers-for-Platforms dispatch namespace and provisioned
 * by the shared control plane (assertSandboxContract refuses a CONTROL_PLANE binding or
 * a service binding to a platform worker).
 *
 * One `ScopeDO` per scope (kernel + protocol engine + the Meridian module bundled) that
 * evaluates permissions from its OWN storage; a thin Hono API that authenticates →
 * getScope → invoke; the built SPA inlined into the worker (no ASSETS binding — WfP
 * static assets are a separate upload path). No ControlPlaneDO, no CONTROL_PLANE_SVC, no
 * Scrive cron — the router asserts the node, the shared plane owns the directory + audit.
 *
 * Local run:  wrangler dev            (real workerd, no account; ALLOW_DEV_HEADER)
 * Deploy:     substrat push           (into the WfP dispatch namespace) — see DEPLOY.md
 */
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { principalId, scopeId, tenantId, z } from '@substrat-run/contracts';
import { defineScopeDO, CloudflareScopeHost } from '@substrat-run/adapter-cloudflare';
import {
  assertPlatformCall,
  PlatformCallError,
  readRoutedNode,
  RouterAssertionError,
} from '@substrat-run/kernel';
import { MODULES, ROLES } from './provision.js';
import { buildAuth } from './auth.js';
import { serveAsset } from './assets.js';
import {
  betterAuthAdapter,
  devHeaderAdapter,
  resolvePrincipal,
  type AuthAdapter,
  type CompanyNode,
  type IdentityDirectory,
} from './auth-adapters.js';

/** The scope-DO class = the app binary: kernel + protocol + Meridian, bundled. */
export const ScopeDO = defineScopeDO(MODULES, {});

// A fixed dev node (valid ULIDs). Behind the router the node comes from the resolved
// hostname; this is ONLY the fallback for local `wrangler dev`, where there is no router
// to assert one, and is gated on ALLOW_DEV_HEADER (never set in prod).
const DEV_NODE: CompanyNode = {
  tenantId: tenantId.parse('01JZ0000000000000000MER001'),
  scopeId: scopeId.parse('01JZ0000000000000000MER002'),
};

interface Env {
  // A sandbox-clean vertical (scope-local-permissions.md Phase 3): its ONLY durable
  // stores are its own SCOPE DO class + AUTH_DB. No CONTROL_PLANE binding, no service
  // binding to a platform worker — assertSandboxContract refuses those.
  SCOPE: DurableObjectNamespace;
  AUTH_DB: D1Database;
  /** The built SPA is inlined into the worker (src/assets.ts) — no ASSETS binding here. */
  BETTER_AUTH_SECRET?: string;
  BASE_URL?: string;
  /** Local dev only: when 'true', trust the `x-principal` header. NEVER set in prod. */
  ALLOW_DEV_HEADER?: string;
  /** Shared secret the router presents (K-26): how the vertical knows the asserted node came from the router. */
  ROUTER_SECRET?: string;
  /** Shared secret the CONTROL PLANE presents to provision/link here (K-31). Unset ⇒ refused. */
  PLATFORM_SECRET?: string;
}

/**
 * Which tenant/scope this request is for. Behind the router: whatever the hostname
 * resolved to (signed headers). Local dev (ALLOW_DEV_HEADER): the fixed dev node.
 * Neither: refuse — an unrouted request in a multi-tenant deployment has no defensible
 * default, and picking one would mean serving somebody else's data.
 */
function nodeFor(req: Request, env: Env): CompanyNode {
  let routed;
  try {
    routed = readRoutedNode(req.headers, { expectedSecret: env.ROUTER_SECRET });
  } catch (e) {
    if (e instanceof RouterAssertionError) throw new HTTPException(400, { message: e.message });
    throw e;
  }
  if (routed) return { tenantId: routed.tenantId, scopeId: routed.scopeId };
  if (env.ALLOW_DEV_HEADER === 'true') return DEV_NODE;
  throw new HTTPException(503, { message: 'no scope was asserted for this request (missing router assertion)' });
}

/**
 * The coordinator is stateless — rebuilt per request; durable state is in the DOs.
 * CP-less: NO control plane. Permissions evaluate from each scope's own storage; the
 * router asserts the node, so this vertical trusts it rather than reading a directory it
 * has no binding to. Its only durable stores are its own `SCOPE` DO class and `AUTH_DB`.
 */
function hostFor(env: Env): CloudflareScopeHost {
  const host = new CloudflareScopeHost({ scope: env.SCOPE });
  for (const m of MODULES) host.registerModule(m);
  return host;
}

const originOf = (req: Request): string => new URL(req.url).origin;

/**
 * The CP-less identity directory: with no control plane to bind identities into, the
 * vertical's OWN Better Auth store IS the id→principal map. The `principal_id` column on
 * the `user` row (migrations/0002) holds the binding — set by /internal/link when a
 * provisioned instance's owner is made usable, read on every login after.
 */
function d1IdentityDirectory(db: D1Database): IdentityDirectory {
  return {
    async resolve(externalId) {
      const row = (await db
        .prepare('SELECT principal_id FROM user WHERE id = ?')
        .bind(externalId)
        .first()) as { principal_id: string | null } | null;
      return row?.principal_id ? principalId.parse(row.principal_id) : null;
    },
    async bind(externalId, principal) {
      await db.prepare('UPDATE user SET principal_id = ? WHERE id = ?').bind(principal, externalId).run();
    },
  };
}

/**
 * The mounted auth seam: Better Auth (a D1 session cookie), resolved through the CP-less
 * directory. The kernel only ever receives the resolved `PrincipalId`. The `x-principal`
 * dev-header is an impersonation bypass, mounted ONLY when ALLOW_DEV_HEADER=true.
 */
function adaptersFor(env: Env, req: Request): AuthAdapter[] {
  const adapters: AuthAdapter[] = [
    betterAuthAdapter(buildAuth(env, originOf(req)), d1IdentityDirectory(env.AUTH_DB)),
  ];
  if (env.ALLOW_DEV_HEADER === 'true') adapters.push(devHeaderAdapter());
  return adapters;
}

const provisionInstanceBody = z.object({
  tenantId,
  scopeId,
  owner: principalId,
  slug: z.string().min(1),
  name: z.string().min(1),
});

const linkBody = z.object({
  /** The Better Auth user id (from sign-up) to bind to `principal`. */
  externalId: z.string().min(1),
  principal: principalId,
});

const app = new Hono<{ Bindings: Env }>();

// Better Auth owns identity/credentials/sessions in D1, mounted under /api/auth/*.
app.on(['GET', 'POST'], '/api/auth/*', (c) => buildAuth(c.env, originOf(c.req.raw)).handler(c.req.raw));

/**
 * Provision ONE instance on the platform's instruction (K-31), CP-less. The shared
 * control plane already owns this scope's directory row + entitlements (the dashboard
 * wrote them before calling here), so the vertical sets up only the scope's OWN state:
 * migrate the module tables, project the role defs, grant the owner `hr-admin` at scope
 * level. No tenant, no control plane. Platform-secret gated; NOT under /api/*. Idempotent.
 */
app.post('/internal/provision', async (c) => {
  try {
    assertPlatformCall(c.req.raw.headers, { expectedSecret: c.env.PLATFORM_SECRET });
  } catch (e) {
    if (e instanceof PlatformCallError) throw new HTTPException(403, { message: e.message });
    throw e;
  }
  const body = provisionInstanceBody.parse(await c.req.json());
  await hostFor(c.env).provisionScopeLocal({
    tenantId: body.tenantId,
    scopeId: body.scopeId,
    owner: body.owner,
    roles: ROLES,
    ownerRoleKey: 'hr-admin',
  });
  return c.json({ tenantId: body.tenantId, scopeId: body.scopeId, owner: body.owner }, 201);
});

/**
 * Bind a Better Auth login to a principal (K-31 follow-on) — how the portal (or an admin)
 * makes a freshly-provisioned instance usable by a real login: the owner signs up, and
 * this links that user id to the owner principal in the vertical's own `user` row.
 * Registering an email alone grants nothing until this runs. Platform-secret gated.
 */
app.post('/internal/link', async (c) => {
  try {
    assertPlatformCall(c.req.raw.headers, { expectedSecret: c.env.PLATFORM_SECRET });
  } catch (e) {
    if (e instanceof PlatformCallError) throw new HTTPException(403, { message: e.message });
    throw e;
  }
  const body = linkBody.parse(await c.req.json());
  await d1IdentityDirectory(c.env.AUTH_DB).bind(body.externalId, body.principal);
  return c.json({ linked: true }, 201);
});

/** Resolve the caller across the mounted adapters → the routed node → a scope stub. 401 if none. */
async function stub(c: { env: Env; req: { raw: Request } }) {
  const node = nodeFor(c.req.raw, c.env);
  const result = await resolvePrincipal(adaptersFor(c.env, c.req.raw), c.req.raw.headers);
  if (!result) throw new HTTPException(401, { message: 'unauthorized' });
  // CP-less: lifecycle is the router's gate — it forwards only an active scope and asserts
  // the node. The vertical trusts that node and opens the scope; permissions evaluate locally.
  return hostFor(c.env).getScope(result.principal, node.tenantId, node.scopeId);
}

/**
 * Who am I, in the shape the SPA centres on: `{ key, display, role, country, employeeId }`.
 * The principal comes from the auth seam; the role hint + linked employee come from the
 * scope itself (`hr/whoami`), so a real hosted owner (holding `hr-admin`) lands on the
 * admin surface and an employee on their own work — the same shape the dev server serves.
 */
app.get('/api/me', async (c) => {
  const node = nodeFor(c.req.raw, c.env);
  const result = await resolvePrincipal(adaptersFor(c.env, c.req.raw), c.req.raw.headers);
  if (!result) return c.json({ error: 'unauthorized' }, 401);
  const scope = await hostFor(c.env).getScope(result.principal, node.tenantId, node.scopeId);
  const who = (await scope.invoke('hr/whoami', undefined)) as {
    role: string;
    country: 'SE' | 'ES';
    employeeId: string | null;
  };
  return c.json({
    key: result.principal,
    // Better Auth carries a name; the dev-header path carries none — default so the
    // shape the SPA consumes is always total.
    display: result.display ?? 'You',
    role: who.role,
    country: who.country,
    employeeId: who.employeeId,
  });
});

/**
 * The persona switcher is a DEV affordance (the demo's cast of characters). A real hosted
 * instance has one signed-in user and no cast, so this is empty — the app hides the
 * switcher when the cast is empty. Kept as an explicit route (rather than a 404 the SPA
 * catch-all would swallow) so the client gets clean JSON.
 */
app.get('/api/cast', (c) => c.json([]));

// Generic invoke: the kernel checks the permission inside every operation, so a generic
// route is exactly as safe as an explicit table — and far less code.
app.post('/api/invoke', async (c) => {
  const { op, input } = await c.req.json<{ op: string; input?: unknown }>();
  return c.json((await (await stub(c)).invoke(op, input)) ?? null);
});

// Serve the inlined SPA for everything that isn't an /api or /internal route. MUST come
// after all those routes so Hono handles /api/auth/* etc. first; the catch-all then serves
// the bundled SPA (src/assets.ts), returning index.html for unknown client routes.
app.all('*', (c) => serveAsset(new URL(c.req.url)));

app.onError((err, c) => {
  const status = err instanceof HTTPException ? err.status : 400;
  const m = err instanceof Error ? err.message : String(err);
  if (status === 400 && /permission denied/.test(m)) return c.json({ error: m }, 403);
  if (status === 400 && /not found|unknown scope/.test(m)) return c.json({ error: m }, 404);
  return c.json({ error: m }, status);
});

export default app;
