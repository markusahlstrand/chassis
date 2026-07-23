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
import type { PrincipalId } from '@substrat-run/contracts';
import { MODULES, ROLES } from './provision.js';
import { serveAsset } from './assets.js';
import type { CompanyNode } from './auth-adapters.js';
import { AuthDO, doAuthProvider } from './auth-do.js';
import { oidcAuthProvider } from './auth-oidc.js';
import type { AuthProvider } from './auth-provider.js';

/** The scope-DO class = the app binary: kernel + protocol + Meridian, bundled. */
export const ScopeDO = defineScopeDO(MODULES, {});
/** The per-tenant identity DO — the sub→principal directory, and Better Auth when that provider is chosen. */
export { AuthDO };

// A fixed dev node (valid ULIDs). Behind the router the node comes from the resolved
// hostname; this is ONLY the fallback for local `wrangler dev`, where there is no router
// to assert one, and is gated on ALLOW_DEV_HEADER (never set in prod).
const DEV_NODE: CompanyNode = {
  tenantId: tenantId.parse('01JZ0000000000000000MER001'),
  scopeId: scopeId.parse('01JZ0000000000000000MER002'),
};

interface Env {
  // A sandbox-clean vertical (scope-local-permissions.md Phase 3): its ONLY durable stores
  // are its OWN DO classes — SCOPE (business data, per scope) and AUTH (identity, per
  // tenant). No shared D1 `AUTH_DB`, no CONTROL_PLANE binding, no service binding — all
  // refused by assertSandboxContract. AUTH being an OWN class is what keeps it legal.
  SCOPE: DurableObjectNamespace;
  AUTH: DurableObjectNamespace<AuthDO>;
  /**
   * Which auth the app runs — the config section. `better-auth-do` (default): Better Auth
   * in the per-tenant AUTH DO. `oidc`: verify a bearer token against an OIDC issuer
   * (`OIDC_ISSUER` [+ `OIDC_AUDIENCE`]) — covers Supabase, Auth0, AuthHero, Keycloak, …
   * The app never changes; only this config + the provider behind the contract does.
   */
  AUTH_PROVIDER?: string;
  OIDC_ISSUER?: string;
  OIDC_AUDIENCE?: string;
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

/** The tenant's identity DO stub — the sub→principal directory (and Better Auth, if chosen). */
function identityDo(env: Env, node: CompanyNode) {
  return env.AUTH.get(env.AUTH.idFromName(node.tenantId));
}

/**
 * The `AuthProvider` for this request, chosen by CONFIG — the whole point of the contract.
 * `oidc` verifies a bearer token against the configured issuer (Supabase / Auth0 / AuthHero
 * / Keycloak); default `better-auth-do` runs Better Auth in the tenant's AUTH DO. The app
 * never learns which; it only ever holds an `AuthProvider`.
 */
function authProviderFor(env: Env, req: Request): AuthProvider {
  if ((env.AUTH_PROVIDER ?? 'better-auth-do') === 'oidc') {
    if (!env.OIDC_ISSUER) throw new HTTPException(500, { message: 'AUTH_PROVIDER=oidc but OIDC_ISSUER is unset' });
    return oidcAuthProvider({ issuer: env.OIDC_ISSUER, ...(env.OIDC_AUDIENCE ? { audience: env.OIDC_AUDIENCE } : {}) });
  }
  return doAuthProvider(identityDo(env, nodeFor(req, env)), originOf(req));
}

/**
 * Resolve the caller to a PrincipalId for op invocation, PROVIDER-AGNOSTICALLY: the dev
 * header (local only), else the configured provider verifies the request → a subject, and
 * the tenant's identity DO maps that subject → a principal in this scope (claiming the
 * owner seat on first login). Null ⇒ nobody (fail closed).
 */
async function principalFor(env: Env, req: Request): Promise<PrincipalId | null> {
  if (env.ALLOW_DEV_HEADER === 'true') {
    const raw = req.headers.get('x-principal');
    const parsed = raw ? principalId.safeParse(raw) : null;
    if (parsed?.success) return parsed.data;
  }
  const subject = await authProviderFor(env, req).resolve(req.headers);
  if (!subject) return null;
  const node = nodeFor(req, env);
  const principal = await identityDo(env, node).resolvePrincipal(node.scopeId, subject.sub);
  return principal ? principalId.parse(principal) : null;
}

const provisionInstanceBody = z.object({
  tenantId,
  scopeId,
  owner: principalId,
  slug: z.string().min(1),
  name: z.string().min(1),
});

const app = new Hono<{ Bindings: Env }>();

// Identity/credentials/sessions live in the tenant's own AuthDO — the worker just forwards
// the /api/auth/* surface to it through the AuthProvider contract (it never runs Better Auth).
app.on(['GET', 'POST'], '/api/auth/*', (c) => authProviderFor(c.env, c.req.raw).handle(c.req.raw));

/** The verified subject behind the current session, or null — the contract's `resolve`. */
app.get('/api/session', async (c) => c.json(await authProviderFor(c.env, c.req.raw).resolve(c.req.raw.headers)));

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
  // Record the owner seat: whoever first signs in and reaches this scope claims it (becomes
  // hr-admin), whichever provider verifies them. This is how a provisioned instance becomes
  // usable by a real login without the platform knowing the login's subject up front.
  await identityDo(c.env, { tenantId: body.tenantId, scopeId: body.scopeId }).setPendingOwner(body.scopeId, body.owner);
  return c.json({ tenantId: body.tenantId, scopeId: body.scopeId, owner: body.owner }, 201);
});

/** Resolve the caller (any provider) → the routed node → a scope stub. 401 if nobody. */
async function stub(c: { env: Env; req: { raw: Request } }) {
  const node = nodeFor(c.req.raw, c.env);
  const principal = await principalFor(c.env, c.req.raw);
  if (!principal) throw new HTTPException(401, { message: 'unauthorized' });
  // CP-less: lifecycle is the router's gate — it forwards only an active scope and asserts
  // the node. The vertical trusts that node and opens the scope; permissions evaluate locally.
  return hostFor(c.env).getScope(principal, node.tenantId, node.scopeId);
}

app.get('/api/me', async (c) => {
  const principal = await principalFor(c.env, c.req.raw);
  if (!principal) return c.json({ error: 'unauthorized' }, 401);
  return c.json({ principal });
});

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
