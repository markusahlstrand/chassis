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
import { getCookie } from 'hono/cookie';
import { principalId, scopeId, tenantId, platformActorId, z, type PermissionKey } from '@substrat-run/contracts';
import { defineScopeDO, ControlPlaneDO, CloudflareScopeHost } from '@substrat-run/adapter-cloudflare';
import { ulid, type ScopeHost } from '@substrat-run/kernel';
import { protocolModule, PROTOCOL_PERM } from '@substrat-run/engine-protocol';
import { mountOidcRoutes, verifySession, SESSION_COOKIE, type OidcEnv } from '@substrat-run/oidc-rp';
import { dashboardModule } from './module.js';
import { createApp, provisionDashboard, type DashboardNode } from './provision.js';
import { PAGE } from './page.js';

/** The identity provider: the platform's AuthHero instance, via the identity pool. */
const PROVIDER = 'authhero';

// The app binary: the Dashboard vertical + the verticals an app can run (M0: protocol).
const MODULES = [dashboardModule, protocolModule];
export const ScopeDO = defineScopeDO(MODULES, {});
export { ControlPlaneDO };

const STAFF = platformActorId.parse('01JZ000000000000000000DAS1');

/**
 * The catalog: the verticals a customer can instantiate. The LIST is served from
 * the version registry (`registerVertical`/`listVerticals`) — the same registry
 * the operator console will use; `ensureCatalog` seeds it. This map adds the
 * provisioning specifics the registry does not carry (the SKU the app loads under
 * and what the owner is granted inside a fresh app).
 */
const CATALOG: Record<string, { name: string; entitlement: string; ownerGrants: PermissionKey[] }> = {
  protocol: {
    name: 'Documents',
    entitlement: 'protocol',
    ownerGrants: [PROTOCOL_PERM.create, PROTOCOL_PERM.read] as PermissionKey[],
  },
};

/** Seed the registry from the catalog (idempotent) — what `GET /api/catalog` lists. */
async function ensureCatalog(host: ScopeHost): Promise<void> {
  for (const [slug, e] of Object.entries(CATALOG)) {
    await host.admin.registerVertical(STAFF, { slug, name: e.name, source: 'builtin' });
  }
}

interface Env extends OidcEnv {
  SCOPE: DurableObjectNamespace;
  CONTROL_PLANE: DurableObjectNamespace;
}

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
 * and their owner principal. Derived from the OIDC session (the ID token `sub`),
 * NOT the URL.
 *
 * First login **bootstraps the account** (their own tenant + dashboard scope +
 * owner, linked) — self-service sign-up. Returning logins resolve to it. `null`
 * when there is no session.
 */
async function resolveAccount(
  host: ScopeHost,
  env: Env,
  sessionToken: string | undefined,
): Promise<DashboardNode | null> {
  const user = await verifySession(env, sessionToken);
  if (!user) return null;
  const userId = user.id;

  // The pool must exist before we can ask which tenants a login is in (central topology).
  await host.admin.registerIdentityPool(STAFF, { provider: PROVIDER, topology: 'central', tenantId: null });
  const tenants = await host.admin.listIdentityTenants(STAFF, PROVIDER, userId);

  if (tenants.length > 0) {
    const t = tenants[0]!;
    const mapped = await host.admin.resolveIdentity(t, PROVIDER, userId);
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
    slug: slugFor(user.email, userId),
    name: user.name ?? user.email ?? 'Account',
  });
  await host.admin.linkIdentity(STAFF, {
    provider: PROVIDER,
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

// The clickable app — sign in, pick a vertical, create an app, see your apps.
app.get('/', (c) => c.html(PAGE));

// OIDC relying party (AuthHero): /api/auth/login → /callback → /logout.
mountOidcRoutes(app);

/** The catalog — the verticals you can instantiate, from the registry. */
app.get('/api/catalog', async (c) => {
  const host = hostFor(c.env);
  await ensureCatalog(host);
  const verticals = await host.admin.listVerticals(STAFF);
  return c.json(verticals.filter((v) => CATALOG[v.slug]).map((v) => ({ slug: v.slug, name: v.name })));
});

/** Who am I — and, on first call, bootstraps my account. */
app.get('/api/me', async (c) => {
  const node = await resolveAccount(hostFor(c.env), c.env, getCookie(c, SESSION_COOKIE));
  if (!node) return c.json({ error: 'unauthorized' }, 401);
  return c.json({ principal: node.principal, tenant: node.tenantId, dashboardScope: node.scopeId });
});

/** My apps. */
app.get('/api/apps', async (c) => {
  const host = hostFor(c.env);
  const node = await resolveAccount(host, c.env, getCookie(c, SESSION_COOKIE));
  if (!node) throw new HTTPException(401, { message: 'unauthorized' });
  const dash = await host.getScope(node.principal, node.tenantId, node.scopeId);
  return c.json(await dash.invoke('dashboard/list-apps', {}));
});

/** Create an app — provisioned into MY tenant (from the session), authorized in-scope. */
app.post('/api/apps', async (c) => {
  const host = hostFor(c.env);
  const node = await resolveAccount(host, c.env, getCookie(c, SESSION_COOKIE));
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
