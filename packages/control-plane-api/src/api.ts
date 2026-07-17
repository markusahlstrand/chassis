import { Hono } from 'hono';
import {
  adminAction,
  createTenantInput,
  jurisdiction,
  scopeId as scopeIdSchema,
  scopeStatus,
  storageShape,
  tenantId as tenantIdSchema,
  tenantStatus,
  z,
} from '@substrat-run/contracts';
import type { PlatformActorId, ScopeId, TenantId } from '@substrat-run/contracts';
import type { ScopeHost } from '@substrat-run/kernel';
import type { PlatformActorAuth } from './auth.js';
import { mapError } from './errors.js';

export interface ControlPlaneApiOptions {
  host: ScopeHost;
  /**
   * Resolves the platform actor from the request. No default: an unauthenticated
   * control plane is not a sensible fallback, and a package that shipped one
   * would eventually be deployed with it (control-plane.md §6).
   */
  authenticate: PlatformActorAuth;
}

type Vars = { actor: PlatformActorId };

// -- request schemas ---------------------------------------------------------
// Parse, don't trust: every input crosses Zod at the boundary. The ids stay
// CALLER-SUPPLIED rather than minted here, exactly as the contract has them —
// that is what keeps `createTenant`/`provisionScope` idempotent (§3.3: "safe to
// re-run"). Minting server-side would be friendlier and would silently turn a
// retry into a second tenant. This surface is a transport; it does not invent
// semantics on top of HostAdmin.

const provisionScopeBody = z.object({
  tenantId: tenantIdSchema,
  scopeId: scopeIdSchema,
  slug: z.string().optional(),
  kind: z.string().optional(),
  name: z.string().optional(),
  vertical: z.string().nullable().optional(),
  storageShape: storageShape.optional(),
  jurisdiction: jurisdiction.optional(),
});

const setTenantStatusBody = z.object({ status: tenantStatus });

/** Repeatable query params arrive as `?status=active&status=suspended`. */
const listScopesQuery = z.object({
  tenantId: tenantIdSchema.optional(),
  status: z.array(scopeStatus).optional(),
  vertical: z.string().optional(),
});

const auditLogQuery = z.object({
  tenantId: tenantIdSchema.optional(),
  scopeId: scopeIdSchema.optional(),
  actor: z.string().optional(),
  action: z.array(adminAction).optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  limit: z.coerce.number().int().positive().max(1000).optional(),
  cursor: z.string().optional(),
  order: z.enum(['asc', 'desc']).optional(),
});

/**
 * The audited HTTP surface over `HostAdmin` (control-plane.md §4.5).
 *
 * This is the OUT-OF-BAND control plane §3 argues for: it is not module code, it
 * never receives a `ctx`, and it never runs in a scope's serialization domain —
 * so `boundary-lint` is untouched (§7). It is one router over the kernel seam,
 * mounted by whichever transport is hosting it (a Node server locally, a Worker
 * holding the `controlPlane` binding on Cloudflare).
 *
 * Two rules hold everywhere below, and they are the reason this can exist at all:
 *
 * 1. **The actor comes from the authenticated request, never the body.** §4.4:
 *    every field of an audit row except before/after is stamped platform-side,
 *    "never supplied by the caller". A route that read an actor from JSON would
 *    make the entire trail forgeable, which is the one thing that must not be
 *    retrofitted (K-20). Note there is no route here that accepts an `actor`
 *    field at all — it is unrepresentable, not merely ignored.
 * 2. **Reads are exposed; enforcement writes are not.** defineRole / assignRole /
 *    grant / grantToOrg / addMember / linkIdentity are on `HostAdmin` but get no
 *    route: the console's v1 job is the tenant registry, lifecycle, entitlements
 *    and history. `resolveIdentity` especially stays off — it is the auth
 *    adapter's read path, not an admin surface.
 */
export function createControlPlaneApi(options: ControlPlaneApiOptions): Hono<{ Variables: Vars }> {
  const { host, authenticate } = options;
  const admin = host.admin;
  const app = new Hono<{ Variables: Vars }>();

  // Fail closed, before any route runs: no actor, no reach.
  app.use('*', async (c, next) => {
    const actor = await authenticate(c.req.raw);
    if (!actor) return c.json({ error: 'unauthenticated' }, 401);
    c.set('actor', actor);
    await next();
  });

  // One error boundary for every route: adapters throw plain Errors, and each
  // one is a fail-closed refusal that must reach the caller as a status, not a
  // stack trace.
  app.onError((err, c) => {
    if (err instanceof z.ZodError) {
      return c.json({ error: 'invalid request', issues: err.issues }, 400);
    }
    const { status, body } = mapError(err);
    return c.json(body, status);
  });

  // -- tenant registry (§4.1) ------------------------------------------------

  app.get('/tenants', async (c) => c.json(await admin.listTenants()));

  app.post('/tenants', async (c) => {
    const input = createTenantInput.parse(await c.req.json());
    await admin.createTenant(c.get('actor'), input);
    // Idempotent (§4.1): re-creating an existing tenant is a no-op, not an error,
    // so this reads back rather than reporting a create that may not have happened.
    return c.json(await admin.getTenant(input.id), 201);
  });

  app.get('/tenants/:tenantId', async (c) => {
    const tenantId = tenantIdSchema.parse(c.req.param('tenantId'));
    const tenant = await admin.getTenant(tenantId);
    if (!tenant) return c.json({ error: `unknown tenant: ${tenantId}` }, 404);
    return c.json(tenant);
  });

  app.patch('/tenants/:tenantId/status', async (c) => {
    const tenantId = tenantIdSchema.parse(c.req.param('tenantId'));
    const { status } = setTenantStatusBody.parse(await c.req.json());
    // The live weapon (§7): `suspended` fails getScope closed for EVERY scope
    // under the tenant. The blast radius is the console's to show; the audit row
    // is this layer's to guarantee.
    await admin.setTenantStatus(c.get('actor'), tenantId, status);
    return c.json(await admin.getTenant(tenantId));
  });

  // -- entitlements (§4.3) ---------------------------------------------------

  app.get('/tenants/:tenantId/entitlements', async (c) =>
    c.json(await admin.listEntitlements(tenantIdSchema.parse(c.req.param('tenantId')))),
  );

  app.put('/tenants/:tenantId/entitlements/:key', async (c) => {
    const tenantId = tenantIdSchema.parse(c.req.param('tenantId'));
    await admin.grantEntitlement(c.get('actor'), tenantId, c.req.param('key'));
    return c.json(await admin.listEntitlements(tenantId));
  });

  app.delete('/tenants/:tenantId/entitlements/:key', async (c) => {
    const tenantId = tenantIdSchema.parse(c.req.param('tenantId'));
    await admin.revokeEntitlement(c.get('actor'), tenantId, c.req.param('key'));
    return c.json(await admin.listEntitlements(tenantId));
  });

  // -- the scope directory (§3.2/§4.2) ---------------------------------------

  app.get('/scopes', async (c) => {
    const filter = listScopesQuery.parse({
      tenantId: c.req.query('tenantId'),
      status: c.req.queries('status'),
      vertical: c.req.query('vertical'),
    });
    return c.json(await admin.listScopes(filter));
  });

  app.post('/scopes', async (c) => {
    const input = provisionScopeBody.parse(await c.req.json());
    await host.provisionScope(c.get('actor'), input as Parameters<ScopeHost['provisionScope']>[1]);
    const record = await admin.getScopeRecord(input.tenantId, input.scopeId);
    return c.json(record, 201);
  });

  app.get('/tenants/:tenantId/scopes/:scopeId', async (c) => {
    const tenantId = tenantIdSchema.parse(c.req.param('tenantId'));
    const scopeId = scopeIdSchema.parse(c.req.param('scopeId'));
    const record = await admin.getScopeRecord(tenantId, scopeId);
    // Absent, or present under another tenant — indistinguishable on purpose (K-3).
    if (!record) return c.json({ error: `unknown scope for tenant: (${tenantId}, ${scopeId})` }, 404);
    return c.json(record);
  });

  // The four lifecycle transitions, one route each — mirroring the four audited
  // actions rather than collapsing into a PATCH that would accept a target
  // status the transition graph forbids. The graph is enforced below the seam;
  // an illegal transition surfaces as a 409.
  const transitions = {
    suspend: (a: PlatformActorId, t: TenantId, s: ScopeId) => admin.suspendScope(a, t, s),
    unsuspend: (a: PlatformActorId, t: TenantId, s: ScopeId) => admin.unsuspendScope(a, t, s),
    archive: (a: PlatformActorId, t: TenantId, s: ScopeId) => admin.archiveScope(a, t, s),
    unarchive: (a: PlatformActorId, t: TenantId, s: ScopeId) => admin.unarchiveScope(a, t, s),
  } as const;

  for (const [action, run] of Object.entries(transitions)) {
    app.post(`/tenants/:tenantId/scopes/:scopeId/${action}`, async (c) => {
      const tenantId = tenantIdSchema.parse(c.req.param('tenantId'));
      const scopeId = scopeIdSchema.parse(c.req.param('scopeId'));
      await run(c.get('actor'), tenantId, scopeId);
      return c.json(await admin.getScopeRecord(tenantId, scopeId));
    });
  }

  // -- the admin log (§4.4/§4.5) ---------------------------------------------

  app.get('/admin-log', async (c) => {
    const filter = auditLogQuery.parse({
      tenantId: c.req.query('tenantId'),
      scopeId: c.req.query('scopeId'),
      actor: c.req.query('actor'),
      action: c.req.queries('action'),
      since: c.req.query('since'),
      until: c.req.query('until'),
      limit: c.req.query('limit'),
      cursor: c.req.query('cursor'),
      order: c.req.query('order'),
    });
    const entries = await admin.auditLog(filter as Parameters<typeof admin.auditLog>[0]);
    // The cursor IS the last entry's id (ULID order is chronological), so the
    // page carries its own continuation and the console never assembles one.
    return c.json({ entries, nextCursor: entries.at(-1)?.id ?? null });
  });

  return app;
}
