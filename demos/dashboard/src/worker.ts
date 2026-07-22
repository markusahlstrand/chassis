/**
 * The Dashboard — the tenant-facing self-service surface, as a Cloudflare Worker.
 * See docs/design/dashboard.md. M0: sign up → your own tenant is bootstrapped →
 * create an app (a scope running a vertical, in YOUR tenant) → list your apps.
 *
 * The tenant is never a request argument: it is the account the authenticated user
 * owns, so a caller can only ever provision into their own tenant (§4). For M0 the
 * apps run in THIS deployment (the ScopeDO bundles the app verticals); in
 * production each app is a separate vertical deployment reached via the control
 * plane.
 */
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { principalId, scopeId, tenantId, platformActorId, z, type PermissionKey } from '@substrat-run/contracts';
import { defineScopeDO, ControlPlaneDO, CloudflareScopeHost } from '@substrat-run/adapter-cloudflare';
import { ulid, type ScopeHost } from '@substrat-run/kernel';
import { protocolModule, PROTOCOL_PERM } from '@substrat-run/engine-protocol';
import { dashboardModule } from './module.js';
import { createApp, provisionDashboard, type DashboardNode } from './provision.js';
import { buildAuth, type Auth } from './auth.js';

// The app binary: the Dashboard vertical + the verticals an app can run (M0: protocol).
const MODULES = [dashboardModule, protocolModule];
export const ScopeDO = defineScopeDO(MODULES, {});
export { ControlPlaneDO };

const STAFF = platformActorId.parse('01JZ000000000000000000DAS1');

/**
 * The catalog: which verticals a customer can instantiate, and what the owner is
 * granted inside a fresh app. M0 stub — later this is fed by the version registry.
 */
const CATALOG: Record<string, { entitlement: string; ownerGrants: PermissionKey[] }> = {
  protocol: {
    entitlement: 'protocol',
    ownerGrants: [PROTOCOL_PERM.create, PROTOCOL_PERM.read] as PermissionKey[],
  },
};

interface Env {
  SCOPE: DurableObjectNamespace;
  CONTROL_PLANE: DurableObjectNamespace;
  /** Better Auth's edge store — customer identity/credentials/sessions. */
  AUTH_DB: D1Database;
  BETTER_AUTH_SECRET?: string;
  BASE_URL?: string;
}

const originOf = (req: Request): string => new URL(req.url).origin;

/** The coordinator is stateless — rebuilt per request; durable state lives in the DOs + D1. */
function hostFor(env: Env): CloudflareScopeHost {
  const host = new CloudflareScopeHost({ scope: env.SCOPE, controlPlane: env.CONTROL_PLANE });
  for (const m of MODULES) host.registerModule(m);
  return host;
}

/** A URL-safe account slug from the email + a bit of the user id (unique across the platform). */
function slugFor(email: string | null | undefined, userId: string): string {
  const base =
    (email?.split('@')[0] ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') ||
    'account';
  return `${base}-${userId.slice(0, 6).toLowerCase()}`;
}

/**
 * The authenticated customer's account node — the tenant, their dashboard scope,
 * and their owner principal. Derived from the Better Auth session, NOT the URL.
 *
 * First login **bootstraps the account** (their own tenant + dashboard scope +
 * owner, linked) — self-service sign-up. Returning logins resolve to it. `null`
 * when there is no session.
 */
async function resolveAccount(host: ScopeHost, env: Env, req: Request): Promise<DashboardNode | null> {
  const auth: Auth = buildAuth(env, originOf(req));
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session?.user) return null;
  const userId = session.user.id;

  // The pool must exist before we can ask which tenants a login is in (central topology).
  await host.admin.registerIdentityPool(STAFF, { provider: 'better-auth', topology: 'central', tenantId: null });
  const tenants = await host.admin.listIdentityTenants(STAFF, 'better-auth', userId);

  if (tenants.length > 0) {
    const t = tenants[0]!;
    const mapped = await host.admin.resolveIdentity(t, 'better-auth', userId);
    const dash = (await host.admin.listScopes(STAFF, { tenantId: t, vertical: 'dashboard' }))[0];
    if (!mapped || !dash) return null;
    return { tenantId: t, scopeId: dash.id, principal: mapped.principal };
  }

  // Sign-up: this login is a new customer → bootstrap their own account.
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());
  const owner = principalId.parse(ulid());
  await provisionDashboard(host, {
    tenantId: t,
    scopeId: s,
    owner,
    slug: slugFor(session.user.email, userId),
    name: session.user.name ?? session.user.email ?? 'Account',
  });
  await host.admin.linkIdentity(STAFF, {
    provider: 'better-auth',
    externalId: userId,
    principal: owner,
    tenantId: t,
    scopeId: s,
  });
  return { tenantId: t, scopeId: s, principal: owner };
}

const createAppBody = z.object({
  verticalSlug: z.string().min(1),
  name: z.string().min(1),
});

const app = new Hono<{ Bindings: Env }>();

// Better Auth owns identity/credentials/sessions in D1.
app.on(['GET', 'POST'], '/api/auth/*', (c) => buildAuth(c.env, originOf(c.req.raw)).handler(c.req.raw));

/** Who am I — and, on first call, bootstraps my account. */
app.get('/api/me', async (c) => {
  const node = await resolveAccount(hostFor(c.env), c.env, c.req.raw);
  if (!node) return c.json({ error: 'unauthorized' }, 401);
  return c.json({ principal: node.principal, tenant: node.tenantId, dashboardScope: node.scopeId });
});

/** My apps. */
app.get('/api/apps', async (c) => {
  const host = hostFor(c.env);
  const node = await resolveAccount(host, c.env, c.req.raw);
  if (!node) throw new HTTPException(401, { message: 'unauthorized' });
  const dash = await host.getScope(node.principal, node.tenantId, node.scopeId);
  return c.json(await dash.invoke('dashboard/list-apps', {}));
});

/** Create an app — provisioned into MY tenant (from the session), authorized in-scope. */
app.post('/api/apps', async (c) => {
  const host = hostFor(c.env);
  const node = await resolveAccount(host, c.env, c.req.raw);
  if (!node) throw new HTTPException(401, { message: 'unauthorized' });
  const body = createAppBody.parse(await c.req.json());
  const entry = CATALOG[body.verticalSlug];
  if (!entry) throw new HTTPException(400, { message: `unknown vertical '${body.verticalSlug}'` });
  const appRow = await createApp(host, {
    node,
    appScopeId: scopeId.parse(ulid()),
    verticalSlug: body.verticalSlug,
    name: body.name,
    appEntitlementKey: entry.entitlement,
    appOwnerGrants: entry.ownerGrants,
  });
  return c.json(appRow, 201);
});

app.onError((err, c) => {
  const status = err instanceof HTTPException ? err.status : 400;
  const m = err instanceof Error ? err.message : String(err);
  if (status === 400 && /permission denied/.test(m)) return c.json({ error: m }, 403);
  return c.json({ error: m }, status);
});

export default app;
