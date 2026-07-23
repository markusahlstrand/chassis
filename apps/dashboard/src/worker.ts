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
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { principalId, scopeId, tenantId, orgId, platformActorId, z, type PermissionKey, type TenantId } from '@substrat-run/contracts';
import { defineScopeDO, ControlPlaneDO, CloudflareScopeHost } from '@substrat-run/adapter-cloudflare';
import { ulid, type ScopeHost } from '@substrat-run/kernel';
import { protocolModule, PROTOCOL_PERM as PROTO } from '@substrat-run/engine-protocol';
import { workorderModule, PERM as WO } from '@substrat-run/engine-workorder';
import { invoicingModule, INVOICING_PERM as INV } from '@substrat-run/engine-invoicing';
import { invitesModule } from '@substrat-run/engine-invites';
// The worker-safe subpath: the Callout domain module + perms only, never the demo's
// seed/auth (node + better-auth). M0 bundles the vertical here as a stand-in; the
// production model deploys Callout separately (dashboard.md §6) and — per master-plan
// D-33 — a demo is a template that is COPIED, not imported. This import is the M0 seam.
import { calloutModule, SC_PERM } from '@substrat-run/demo-callout/module';
import { mountOidcRoutes, verifySession, SESSION_COOKIE, type OidcEnv } from '@substrat-run/oidc-rp';
import { dashboardModule, type DashboardAppRow } from './module.js';
import { createApp, deprovisionApp, provisionDashboard, type DashboardNode } from './provision.js';
import { listDeploymentsFromCp, listDeploymentsFromHost, assertOwned } from './deployments.js';
import { TenantNarrowedControlPlane } from './authority.js';
import { transportFor, senderFor, teamInviteEmail } from './email.js';
import type { SendEmailBinding } from '@substrat-run/adapter-email';

/** The identity provider: the platform's AuthHero instance, via the identity pool. */
const PROVIDER = 'authhero';

/**
 * The selected-team cookie. Identity (who you are) lives on `sb_session`; this
 * carries only WHICH of your teams the portal is currently scoped to — kept
 * separate so a team switch never touches the login. It is NOT a security
 * boundary: every read re-verifies the named team is one the caller actually
 * belongs to (`listIdentityTenants`), so a forged value can only ever name a
 * team you are already a member of, and otherwise falls back to your default.
 */
const TEAM_COOKIE = 'sb_team';
const TEAM_COOKIE_MAXAGE = 60 * 60 * 24 * 365;
const teamCookieOpts = (origin: string) => ({
  httpOnly: true,
  secure: origin.startsWith('https:'),
  sameSite: 'Lax' as const,
  path: '/',
  maxAge: TEAM_COOKIE_MAXAGE,
});

// The app binary: the Dashboard vertical + the verticals an app can run. M0 bundles
// the app verticals into this deployment's ScopeDO (see the file header), so every
// module a catalog entry needs must be here: Documents (protocol) and Callout —
// the field-service vertical composing workorder + invoicing + protocol.
const MODULES = [dashboardModule, invitesModule, protocolModule, workorderModule, invoicingModule, calloutModule];
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
const CATALOG: Record<string, { name: string; entitlements: string[]; ownerGrants: PermissionKey[] }> = {
  protocol: {
    name: 'Documents',
    entitlements: ['protocol'],
    ownerGrants: [PROTO.create, PROTO.read] as PermissionKey[],
  },
  // Callout composes three engines, so its SKU is three entitlement flags, and its
  // owner receives the `office-admin` permission set (demos/callout provision.ts)
  // as a flat grant — the Dashboard grants perms per-principal rather than defining
  // roles in the app scope.
  callout: {
    name: 'Callout',
    entitlements: ['workorder', 'invoicing', 'protocol', 'callout'],
    ownerGrants: [
      SC_PERM.customerManage, SC_PERM.facilityManage,
      WO.create, WO.read, WO.assign, WO.report, WO.complete, WO.close,
      INV.read, INV.export,
      PROTO.create, PROTO.fill, PROTO.sign, PROTO.read, PROTO.void,
    ] as PermissionKey[],
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
  /**
   * CONNECTED mode (production): a service binding to `substrat-control-plane` — the
   * shared directory the router reads. When bound (with a service token), apps are
   * provisioned there through the tenant-narrowed seam (§4) so they are REACHABLE,
   * rather than into this deployment's own DOs. Absent ⇒ the M0 embedded path.
   */
  CONTROL_PLANE_SVC?: Fetcher;
  /** Shared service credential the control plane resolves to its service actor. */
  CP_SERVICE_TOKEN?: string;
  /** The platform actor id stamped on shared-plane writes (a fixed dashboard actor). */
  CP_ACTOR?: string;
  /**
   * Cloudflare Email Service `send_email` binding — invite + transactional mail.
   * Absent ⇒ the in-memory mock (local dev has no sending domain), so an invite
   * still succeeds; only the email is dropped.
   */
  EMAIL?: SendEmailBinding;
  /** Sender address for platform mail (default `no-reply@send.substrat.net`); domain must be onboarded. */
  EMAIL_FROM?: string;
}

const DASHBOARD_CP_ACTOR = platformActorId.parse('01JZ000000000000000000DASH');

/**
 * The tenant-narrowed control-plane seam for a caller (§4), or `null` in embedded
 * mode. The tenant is pinned to the caller's own — read from their dashboard node,
 * never a request argument — so provisioning cannot escape their tenant.
 */
function controlPlaneFor(env: Env, tenantId: DashboardNode['tenantId']): TenantNarrowedControlPlane | null {
  if (!env.CONTROL_PLANE_SVC || !env.CP_SERVICE_TOKEN) return null;
  return new TenantNarrowedControlPlane({
    // Host is ignored over a service binding; the control-plane API mounts at `/api`.
    baseUrl: 'https://control-plane/api',
    actor: env.CP_ACTOR ?? DASHBOARD_CP_ACTOR,
    serviceToken: env.CP_SERVICE_TOKEN,
    tenantId,
    fetch: env.CONTROL_PLANE_SVC.fetch.bind(env.CONTROL_PLANE_SVC),
  });
}

/** The coordinator is stateless — rebuilt per request; durable state lives in the DOs + D1. */
function hostFor(env: Env): CloudflareScopeHost {
  const host = new CloudflareScopeHost({ scope: env.SCOPE, controlPlane: env.CONTROL_PLANE });
  for (const m of MODULES) host.registerModule(m);
  return host;
}

/** A globally-unique, URL-safe team slug from its name + the tenant id tail. */
function teamSlug(name: string, tenantId: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'team';
  // The tenant ULID is unique, so its tail disambiguates two teams sharing a name.
  const tail = tenantId.toLowerCase().replace(/[^a-z0-9]/g, '').slice(-6) || 'x';
  return `${base}-${tail}`;
}

// -- signed invite token -----------------------------------------------------
// The invite link carries WHERE to accept (which tenant/scope/invitation) in an
// HMAC-signed token (Web Crypto, SESSION_SECRET — the same secret oidc-rp signs
// with). The token is routing, not the secret: the real gate is the invites
// engine re-hashing the recipient's verified email at accept, so a tampered or
// leaked token can only ever accept an invitation sent to the holder's own email.
// Signing just stops the tenant/scope fields being forged to probe other scopes.

interface InviteClaim {
  tenantId: string;
  scopeId: string;
  invitationId: string;
  exp: number;
}

const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlToBytes = (s: string): Uint8Array =>
  Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (ch) => ch.charCodeAt(0));

function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

async function signInviteToken(env: Env, claim: Omit<InviteClaim, 'exp'>): Promise<string> {
  const payload: InviteClaim = { ...claim, exp: Date.now() + 14 * 24 * 60 * 60 * 1000 };
  const body = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = new Uint8Array(
    await crypto.subtle.sign('HMAC', await hmacKey(env.SESSION_SECRET), new TextEncoder().encode(body)),
  );
  return `${body}.${b64url(sig)}`;
}

async function verifyInviteToken(env: Env, token: string): Promise<InviteClaim | null> {
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const ok = await crypto.subtle.verify(
    'HMAC',
    await hmacKey(env.SESSION_SECRET),
    b64urlToBytes(sig),
    new TextEncoder().encode(body),
  );
  if (!ok) return null;
  try {
    const claim = JSON.parse(new TextDecoder().decode(b64urlToBytes(body))) as InviteClaim;
    return claim.exp > Date.now() ? claim : null;
  } catch {
    return null;
  }
}

/** One team the signed-in user belongs to — a tenant, named for the switcher. */
interface Team {
  id: TenantId;
  name: string;
  slug: string;
}

/** The teams a login belongs to, resolved to display names for the switcher. */
async function listTeams(host: ScopeHost, tenants: readonly TenantId[]): Promise<Team[]> {
  const teams: Team[] = [];
  for (const t of tenants) {
    const tenant = await host.admin.getTenant(STAFF, t);
    if (tenant) teams.push({ id: t, name: tenant.name, slug: tenant.slug });
  }
  return teams;
}

/**
 * Resolve the caller's node for one of their teams — the selected team if they are
 * genuinely a member of it (verified: `selectedTeamId` must be in `tenants`), else
 * their first/default team. `null` when the caller belongs to no team, or the
 * chosen team has no resolvable principal/dashboard scope. `tenants` is passed in
 * (already fetched) so the caller reads the directory once.
 */
async function resolveNode(
  host: ScopeHost,
  tenants: readonly TenantId[],
  userId: string,
  selectedTeamId: string | undefined,
): Promise<DashboardNode | null> {
  const t = tenants.find((x) => x === selectedTeamId) ?? tenants[0];
  if (!t) return null;
  const mapped = await host.admin.resolveIdentity(t, PROVIDER, userId);
  const dash = (await host.admin.listScopes(STAFF, { tenantId: t, vertical: 'dashboard' }))[0];
  if (!mapped || !dash) return null;
  return { tenantId: t, scopeId: dash.id, principal: mapped.principal };
}

/**
 * The authenticated customer's account node — the tenant, their dashboard scope,
 * and their principal in that tenant. Derived from the OIDC session (the ID token
 * `sub`) plus the selected-team cookie, NOT the URL.
 *
 * A login can belong to several teams (tenants), so `selectedTeamId` picks which
 * one this request is scoped to; the selection can never name a team you are not
 * in. `null` when there is no session OR the login belongs to no team yet — a
 * teamless login is routed to onboarding by `/api/me`, never here. This resolver
 * is READ-ONLY: teams are created explicitly (`createTeam` / `POST /api/teams`),
 * not as a side effect of resolving who you are.
 */
async function resolveAccount(
  host: ScopeHost,
  env: Env,
  sessionToken: string | undefined,
  selectedTeamId?: string,
): Promise<DashboardNode | null> {
  const user = await verifySession(env, sessionToken);
  if (!user) return null;
  // The pool must exist before we can ask which tenants a login is in (central topology).
  await host.admin.registerIdentityPool(STAFF, { provider: PROVIDER, topology: 'central', tenantId: null });
  const tenants = await host.admin.listIdentityTenants(STAFF, PROVIDER, user.id);
  return resolveNode(host, tenants, user.id, selectedTeamId);
}

/**
 * Create a NEW team for the signed-in user: a tenant, a dashboard scope, and the
 * user as its owner, with their identity linked into it. Used for both the first
 * team (signup onboarding) and additional teams ("New team") — the same move, since
 * the identity directory keys a login's principal per-tenant (K-22), so the same
 * `sub` becomes the owner of each team it creates. Bootstrapping ONE team is the
 * only action that cannot be tenant-narrowed (there is no tenant yet), so it stays
 * a controlled platform action, gated by the authenticated session.
 */
async function createTeam(host: ScopeHost, user: { id: string; email?: string | null }, name: string): Promise<DashboardNode> {
  await host.admin.registerIdentityPool(STAFF, { provider: PROVIDER, topology: 'central', tenantId: null });
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());
  const owner = principalId.parse(ulid());
  await provisionDashboard(host, { tenantId: t, scopeId: s, owner, slug: teamSlug(name, t), name });
  await host.admin.linkIdentity(STAFF, {
    provider: PROVIDER,
    externalId: user.id,
    principal: owner,
    tenantId: t,
    scopeId: s,
  });
  // Seed the roster: one default org to key invitations on, and the owner as the
  // first (active) member. Invoked in-scope as the owner (who holds every key).
  const org = orgId.parse(ulid());
  await host.admin.createOrg(STAFF, { id: org, tenantId: t, slug: 'team', name });
  const scope = await host.getScope(owner, t, s);
  await scope.invoke('dashboard/init-team', { orgId: org, ownerEmail: user.email ?? '' });
  return { tenantId: t, scopeId: s, principal: owner };
}

const createAppBody = z.object({
  verticalSlug: z.string().min(1),
  name: z.string().min(1),
});

// A builder self-serves dev/staging only; prod is refused in the handler (model B).
const promoteBody = z.object({
  channel: z.enum(['dev', 'staging', 'prod']),
  versionId: z.string().min(1),
});

const app = new Hono<{ Bindings: Env }>();

// The Dashboard SPA (apps/dashboard/web) is served by the Workers Assets binding
// configured in wrangler.jsonc: asset requests are answered before this worker
// runs, and its `single-page-application` not-found handling serves index.html
// for any non-asset, non-`/api` path so the client router can take over. This
// worker owns only `/api/*` (below).

// OIDC relying party (AuthHero): /api/auth/login → /callback → /logout.
mountOidcRoutes(app);

/** The catalog — the verticals you can instantiate, from the registry. */
app.get('/api/catalog', async (c) => {
  const host = hostFor(c.env);
  await ensureCatalog(host);
  const verticals = await host.admin.listVerticals(STAFF);
  return c.json(verticals.filter((v) => CATALOG[v.slug]).map((v) => ({ slug: v.slug, name: v.name })));
});

/**
 * Who am I — three states: no session ⇒ 401; a session with no team yet ⇒
 * `{ needsOnboarding }` (the app shows "name your first team"); otherwise my
 * current team, my teams, and my dashboard node. Resolving is READ-ONLY — a
 * teamless login is NOT silently bootstrapped; it must create a team explicitly.
 */
app.get('/api/me', async (c) => {
  const host = hostFor(c.env);
  const user = await verifySession(c.env, getCookie(c, SESSION_COOKIE));
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  await host.admin.registerIdentityPool(STAFF, { provider: PROVIDER, topology: 'central', tenantId: null });
  const tenants = await host.admin.listIdentityTenants(STAFF, PROVIDER, user.id);
  if (tenants.length === 0) {
    return c.json({ needsOnboarding: true, email: user.email ?? null, name: user.name ?? null });
  }
  const node = await resolveNode(host, tenants, user.id, getCookie(c, TEAM_COOKIE));
  if (!node) return c.json({ error: 'unauthorized' }, 401);
  // The dashboard scope carries no display identity — the shell shows the signed-in
  // email/name, which live on the OIDC session, so surface them alongside the teams.
  return c.json({
    principal: node.principal,
    tenant: node.tenantId,
    dashboardScope: node.scopeId,
    email: user.email ?? null,
    name: user.name ?? null,
    teams: await listTeams(host, tenants),
    currentTeamId: node.tenantId,
  });
});

/**
 * Create a team — the signup-onboarding move AND the in-app "New team" action share
 * this one endpoint. The new team is provisioned with the caller as owner and their
 * identity linked, then the `sb_team` cookie is pointed at it so the portal opens on
 * the new team after the client reloads.
 */
const createTeamBody = z.object({ name: z.string().trim().min(1).max(100) });
app.post('/api/teams', async (c) => {
  const user = await verifySession(c.env, getCookie(c, SESSION_COOKIE));
  if (!user) throw new HTTPException(401, { message: 'unauthorized' });
  const { name } = createTeamBody.parse(await c.req.json());
  const host = hostFor(c.env);
  const node = await createTeam(host, user, name);
  setCookie(c, TEAM_COOKIE, node.tenantId, teamCookieOpts(new URL(c.req.url).protocol));
  return c.json({ teamId: node.tenantId }, 201);
});

/**
 * Switch the current team — validates the caller is a member, then pins the choice
 * in the `sb_team` cookie. The whole portal (apps, domains, billing) re-scopes to
 * the selected tenant on the next load, because every handler resolves the node
 * from this cookie. Naming a team you are not in is refused, not silently ignored.
 */
const switchTeamBody = z.object({ teamId: z.string().min(1) });
app.post('/api/teams/switch', async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  const user = await verifySession(c.env, token);
  if (!user) throw new HTTPException(401, { message: 'unauthorized' });
  const { teamId } = switchTeamBody.parse(await c.req.json());
  const host = hostFor(c.env);
  await host.admin.registerIdentityPool(STAFF, { provider: PROVIDER, topology: 'central', tenantId: null });
  const tenants = await host.admin.listIdentityTenants(STAFF, PROVIDER, user.id);
  if (!tenants.some((t) => t === teamId)) {
    throw new HTTPException(403, { message: 'not a member of that team' });
  }
  setCookie(c, TEAM_COOKIE, teamId, teamCookieOpts(new URL(c.req.url).protocol));
  return c.body(null, 204);
});

/**
 * Leave a team — the caller detaches themselves: mark their roster row revoked, then
 * sever their identity link so the team leaves their switcher and they can no longer
 * resolve into it. The selected-team cookie is cleared so the next load re-resolves
 * (another team, or onboarding if this was their last). Self-service; no role needed
 * beyond membership. Leaving the team you have selected — no team id argument.
 */
app.post('/api/teams/leave', async (c) => {
  const host = hostFor(c.env);
  const node = await resolveAccount(host, c.env, getCookie(c, SESSION_COOKIE), getCookie(c, TEAM_COOKIE));
  if (!node) throw new HTTPException(401, { message: 'unauthorized' });
  const scope = await host.getScope(node.principal, node.tenantId, node.scopeId);
  await scope.invoke('dashboard/leave-self', {});
  await host.admin.unlinkIdentity(STAFF, node.tenantId, node.principal);
  deleteCookie(c, TEAM_COOKIE, { path: '/' });
  return c.body(null, 204);
});

/** The current team's roster — active members + outstanding invites. */
app.get('/api/members', async (c) => {
  const host = hostFor(c.env);
  const node = await resolveAccount(host, c.env, getCookie(c, SESSION_COOKIE), getCookie(c, TEAM_COOKIE));
  if (!node) throw new HTTPException(401, { message: 'unauthorized' });
  const scope = await host.getScope(node.principal, node.tenantId, node.scopeId);
  return c.json(await scope.invoke('dashboard/list-members', {}));
});

/**
 * Invite a member to the current team at a role. The in-scope op enforces the §5.1
 * bound (invite only at a role you already hold) and composes the invites engine,
 * then we email the invitee an accept link.
 *
 * The email is sent HERE, host-side, because this is the only place the raw address
 * exists: the invites engine hashes the identifier and the `invites.sent` event
 * carries only the hash (piiClass 'none'), so no outbox executor could recover an
 * address to send to. Delivery is best-effort — the invitation is already committed,
 * so a send failure is reported (`emailDelivered: false`) rather than rolling back a
 * recorded invite; the returned `acceptUrl` lets the inviter share the link manually
 * and is what a resend would use.
 */
const inviteMemberBody = z.object({
  email: z.string().trim().min(1),
  roleKey: z.enum(['admin', 'member', 'viewer']),
});
app.post('/api/members/invite', async (c) => {
  const host = hostFor(c.env);
  const user = await verifySession(c.env, getCookie(c, SESSION_COOKIE));
  if (!user) throw new HTTPException(401, { message: 'unauthorized' });
  const node = await resolveAccount(host, c.env, getCookie(c, SESSION_COOKIE), getCookie(c, TEAM_COOKIE));
  if (!node) throw new HTTPException(401, { message: 'unauthorized' });
  const body = inviteMemberBody.parse(await c.req.json());
  const scope = await host.getScope(node.principal, node.tenantId, node.scopeId);
  const { invitationId } = (await scope.invoke('dashboard/invite-member', body)) as { invitationId: string };
  const token = await signInviteToken(c.env, {
    tenantId: node.tenantId,
    scopeId: node.scopeId,
    invitationId,
  });
  const acceptUrl = `${new URL(c.req.url).origin}/invite/${token}`;

  const team = await host.admin.getTenant(STAFF, node.tenantId);
  let emailDelivered = false;
  try {
    const result = await transportFor(c.env).send(
      teamInviteEmail({
        to: body.email,
        from: senderFor(c.env),
        teamName: team?.name ?? 'your team',
        inviterName: user.name,
        acceptUrl,
      }),
    );
    emailDelivered = result.delivered.length > 0;
  } catch (err) {
    // A committed invite with a failed email is recoverable (resend); a thrown 500
    // that hides the invitationId is not. Log and report, don't fail the request.
    console.error('invite email send failed:', err instanceof Error ? err.message : err);
  }
  return c.json({ invitationId, acceptUrl, emailDelivered }, 201);
});

/** Withdraw a pending invite from the current team. */
app.post('/api/members/revoke-invite', async (c) => {
  const host = hostFor(c.env);
  const node = await resolveAccount(host, c.env, getCookie(c, SESSION_COOKIE), getCookie(c, TEAM_COOKIE));
  if (!node) throw new HTTPException(401, { message: 'unauthorized' });
  const { invitationId } = z.object({ invitationId: z.string().min(1) }).parse(await c.req.json());
  const scope = await host.getScope(node.principal, node.tenantId, node.scopeId);
  await scope.invoke('dashboard/revoke-invite', { invitationId });
  return c.body(null, 204);
});

/**
 * Remove an active member: mark the roster row revoked AND revoke their kernel role
 * (`unassignRole`) so access is actually cut — the projection alone would not. The
 * op authorizes (manage-members) and returns the principal + role to unassign; the
 * owner cannot be removed. Their identity link is left, so the team still appears in
 * their own switcher but resolves to no permissions (fully hiding it needs a kernel
 * `unlinkIdentity` — a follow-up).
 */
app.post('/api/members/remove', async (c) => {
  const host = hostFor(c.env);
  const node = await resolveAccount(host, c.env, getCookie(c, SESSION_COOKIE), getCookie(c, TEAM_COOKIE));
  if (!node) throw new HTTPException(401, { message: 'unauthorized' });
  const { memberId } = z.object({ memberId: z.string().min(1) }).parse(await c.req.json());
  const scope = await host.getScope(node.principal, node.tenantId, node.scopeId);
  const removed = (await scope.invoke('dashboard/remove-member', { memberId })) as { principal: string; roleKey: string } | null;
  if (removed) {
    const principal = principalId.parse(removed.principal);
    // Cut access (revoke the role) AND sever their login from the team, so it also
    // disappears from their own switcher rather than lingering as a dead entry.
    await host.admin.unassignRole(DASHBOARD_CP_ACTOR, {
      principalId: principal,
      roleKey: removed.roleKey,
      node: { tenantId: node.tenantId, scopeId: null },
    });
    await host.admin.unlinkIdentity(STAFF, node.tenantId, principal);
  }
  return c.body(null, 204);
});

/**
 * Accept an invitation. The recipient is logged in (verified email), presents the
 * signed token. We mint their principal, accept in-scope (the engine re-hashes their
 * email — the real gate), then effect access: assign the invited role at the tenant
 * node and link their identity so future logins resolve into this team. Idempotent:
 * an already-member just switches; a re-used/settled invitation fails at the engine.
 */
app.post('/api/invites/accept', async (c) => {
  const user = await verifySession(c.env, getCookie(c, SESSION_COOKIE));
  if (!user) throw new HTTPException(401, { message: 'unauthorized' });
  const { token } = z.object({ token: z.string().min(1) }).parse(await c.req.json());
  const claim = await verifyInviteToken(c.env, token);
  if (!claim) throw new HTTPException(400, { message: 'this invite link is invalid or has expired' });
  const t = tenantId.parse(claim.tenantId);
  const s = scopeId.parse(claim.scopeId);

  const host = hostFor(c.env);
  await host.admin.registerIdentityPool(STAFF, { provider: PROVIDER, topology: 'central', tenantId: null });
  // Already in this team? Nothing to accept — just switch to it (idempotent link click).
  if (await host.admin.resolveIdentity(t, PROVIDER, user.id)) {
    setCookie(c, TEAM_COOKIE, t, teamCookieOpts(new URL(c.req.url).protocol));
    return c.json({ teamId: t, already: true });
  }

  const principal = principalId.parse(ulid());
  const scope = await host.getScope(principal, t, s);
  // The engine verifies the hash of the recipient's VERIFIED email; a mismatch throws.
  const { roleKey } = (await scope.invoke('dashboard/accept-invite', {
    invitationId: claim.invitationId,
    identifier: user.email ?? '',
  })) as { roleKey: string };

  // Effect access: the role at the tenant node (§5.1 was enforced when it was sent),
  // and the identity link so future logins land in this team.
  await host.admin.assignRole(DASHBOARD_CP_ACTOR, {
    principalId: principal,
    roleKey,
    node: { tenantId: t, scopeId: null },
  });
  await host.admin.linkIdentity(STAFF, {
    provider: PROVIDER,
    externalId: user.id,
    principal,
    tenantId: t,
    scopeId: s,
  });
  setCookie(c, TEAM_COOKIE, t, teamCookieOpts(new URL(c.req.url).protocol));
  return c.json({ teamId: t });
});

/** My apps. */
app.get('/api/apps', async (c) => {
  const host = hostFor(c.env);
  const node = await resolveAccount(host, c.env, getCookie(c, SESSION_COOKIE), getCookie(c, TEAM_COOKIE));
  if (!node) throw new HTTPException(401, { message: 'unauthorized' });
  const dash = await host.getScope(node.principal, node.tenantId, node.scopeId);
  return c.json(await dash.invoke('dashboard/list-apps', {}));
});

/** Create an app — provisioned into MY tenant (from the session), authorized in-scope. */
app.post('/api/apps', async (c) => {
  const host = hostFor(c.env);
  const node = await resolveAccount(host, c.env, getCookie(c, SESSION_COOKIE), getCookie(c, TEAM_COOKIE));
  if (!node) throw new HTTPException(401, { message: 'unauthorized' });
  const body = createAppBody.parse(await c.req.json());
  const entry = CATALOG[body.verticalSlug];
  if (!entry) throw new HTTPException(400, { message: `unknown vertical '${body.verticalSlug}'` });
  // Connected (prod): provision on the shared control plane through the tenant-narrowed
  // seam so the app is reachable via the router. Absent the binding: the M0 embedded path.
  const user = await verifySession(c.env, getCookie(c, SESSION_COOKIE));
  const appRow = await createApp(host, {
    node,
    appScopeId: scopeId.parse(ulid()),
    verticalSlug: body.verticalSlug,
    name: body.name,
    appEntitlements: entry.entitlements,
    appOwnerGrants: entry.ownerGrants,
    controlPlane: controlPlaneFor(c.env, node.tenantId) ?? undefined,
    tenantName: user?.name ?? user?.email ?? 'Workspace',
  });
  return c.json(appRow, 201);
});

/** Delete an app — deprovisions its scope + takes its hostname offline, in MY tenant. */
app.delete('/api/apps/:id', async (c) => {
  const host = hostFor(c.env);
  const node = await resolveAccount(host, c.env, getCookie(c, SESSION_COOKIE), getCookie(c, TEAM_COOKIE));
  if (!node) throw new HTTPException(401, { message: 'unauthorized' });
  // Resolve the app to its scope id + hostname from the caller's OWN apps only — the
  // :id is theirs or it does not exist to them (list-apps is tenant-scoped).
  const dash = await host.getScope(node.principal, node.tenantId, node.scopeId);
  const apps = (await dash.invoke('dashboard/list-apps', {})) as DashboardAppRow[];
  const appRow = apps.find((a) => a.id === c.req.param('id'));
  if (!appRow) throw new HTTPException(404, { message: 'app not found' });
  await deprovisionApp(host, {
    node,
    appScopeId: scopeId.parse(appRow.app_scope_id),
    hostname: appRow.hostname,
    controlPlane: controlPlaneFor(c.env, node.tenantId) ?? undefined,
  });
  return c.body(null, 204);
});

/**
 * My deployments (builder-plane.md Phase 4) — the verticals THIS tenant pushed, with
 * their versions + channels. Connected mode reads the shared plane (tenant-filtered);
 * embedded reads the local host. Either way the tenant is the caller's own, from session.
 */
app.get('/api/deployments', async (c) => {
  const host = hostFor(c.env);
  const node = await resolveAccount(host, c.env, getCookie(c, SESSION_COOKIE), getCookie(c, TEAM_COOKIE));
  if (!node) throw new HTTPException(401, { message: 'unauthorized' });
  const cp = controlPlaneFor(c.env, node.tenantId);
  const deployments = cp
    ? await listDeploymentsFromCp(cp)
    : await listDeploymentsFromHost(host, STAFF, node.tenantId);
  return c.json(deployments);
});

/**
 * Promote one of MY verticals to a NON-PROD channel. `prod` is refused here — production
 * promotion + admission stay a staff decision (model B, self-serve-deploy.md §3). The slug
 * is verified to be one of the caller's own deployments before anything is promoted.
 */
app.post('/api/deployments/:slug/promote', async (c) => {
  const host = hostFor(c.env);
  const node = await resolveAccount(host, c.env, getCookie(c, SESSION_COOKIE), getCookie(c, TEAM_COOKIE));
  if (!node) throw new HTTPException(401, { message: 'unauthorized' });
  const body = promoteBody.parse(await c.req.json());
  if (body.channel === 'prod') {
    throw new HTTPException(403, { message: 'production is promoted by the Substrat team' });
  }
  const slug = c.req.param('slug');
  const cp = controlPlaneFor(c.env, node.tenantId);
  if (cp) {
    assertOwned(await listDeploymentsFromCp(cp), slug); // your vertical, or 4xx
    await cp.promote(slug, body.channel, body.versionId);
  } else {
    assertOwned(await listDeploymentsFromHost(host, STAFF, node.tenantId), slug);
    await host.admin.promoteVersion(STAFF, slug, body.channel, body.versionId);
  }
  return c.body(null, 204);
});

app.onError((err, c) => {
  const status = err instanceof HTTPException ? err.status : 400;
  const m = err instanceof Error ? err.message : String(err);
  if (status === 400 && /permission denied/.test(m)) return c.json({ error: m }, 403);
  // A slug that isn't the caller's own deployment reads as not-found, not a leak.
  if (status === 400 && /not one of your deployments/.test(m)) return c.json({ error: m }, 404);
  return c.json({ error: m }, status);
});

export default app;
