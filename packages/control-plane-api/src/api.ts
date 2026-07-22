import { Hono } from 'hono';
import {
  adminAction,
  channelName,
  createTenantInput,
  hostname as hostnameSchema,
  hostnameRegion,
  hostnameStatus,
  promotionAcknowledgement,
  provisionableJurisdiction,
  publishVersionInput,
  registerVerticalInput,
  scopeId as scopeIdSchema,
  scopeStatus,
  storageShape,
  surfaceName,
  tenantId as tenantIdSchema,
  tenantStatus,
  z,
} from '@substrat-run/contracts';
import type { PlatformActorId, ScopeId, TenantId } from '@substrat-run/contracts';
import type { ScopeHost } from '@substrat-run/kernel';
import { ulid } from '@substrat-run/kernel';
import type { PlatformActorAuth } from './auth.js';
import type { VerticalClient } from './vertical-client.js';
import { ControlPlaneError } from './client.js';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { mapError } from './errors.js';
import { assertSandboxContract, deployManifest, deploymentRefFor } from './deploy.js';
import type { DeployVerticalFn } from './deploy.js';

export interface ControlPlaneApiOptions {
  host: ScopeHost;
  /**
   * How to reach each vertical, by slug (K-31). Absent slugs simply cannot be
   * provisioned — the route 501s rather than pretending, because a control plane that
   * silently does nothing is worse than one that says it cannot.
   *
   * A static map is the milestone-one shape, the same one the router carries and with
   * the same Workers-for-Platforms swap later.
   */
  verticals?: Record<string, VerticalClient>;
  /**
   * Resolves a vertical dynamically — the dispatch swap for provisioning (orchestration.md
   * §5.4), the mirror of the router's `verticalFor`. Given a slug, the host looks up the
   * vertical's `prod` channel version and returns a `VerticalClient` over
   * `env.DISPATCH.get(deploymentRef)`. Tried after the static `verticals` map, so a
   * pushed vertical is provisionable with no redeploy. Absent ⇒ only static bindings.
   */
  resolveVertical?: (slug: string, actor: PlatformActorId) => Promise<VerticalClient | undefined>;
  /**
   * Uploads a built vertical bundle to the platform runtime (a WfP dispatch
   * namespace), injected by the host so this package holds no Cloudflare SDK and the
   * builder never holds a Cloudflare credential (D-34). Absent ⇒ the deploy route
   * 501s. See `deploy.ts`.
   */
  deployVertical?: DeployVerticalFn;
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
  // The gate: only `global` is accepted until `eu`/`us` enforcement exists (K-32).
  // A request naming a jurisdiction we cannot yet honour is refused at the Zod
  // boundary with 400, rather than recorded as a residency claim with no mechanism.
  jurisdiction: provisionableJurisdiction.optional(),
});

const setTenantStatusBody = z.object({ status: tenantStatus });

const provisionInstanceBody = z.object({
  tenantId: tenantIdSchema,
  scopeId: scopeIdSchema,
  owner: z.string().min(1),
  slug: z.string().min(1),
  name: z.string().min(1),
});

const bindHostnameBody = z.object({
  hostname: hostnameSchema,
  tenantId: tenantIdSchema,
  scopeId: scopeIdSchema,
  surface: surfaceName,
  region: hostnameRegion.optional().default(null),
  canonical: z.boolean().optional().default(false),
});

const setHostnameStatusBody = z.object({
  status: hostnameStatus,
  note: z.string().optional(),
});

const listHostnamesQuery = z.object({
  tenantId: tenantIdSchema.optional(),
  scopeId: scopeIdSchema.optional(),
});

/** Repeatable query params arrive as `?status=active&status=suspended`. */
const listScopesQuery = z.object({
  tenantId: tenantIdSchema.optional(),
  status: z.array(scopeStatus).optional(),
  vertical: z.string().optional(),
});

// -- vertical + version registry bodies (#31; orchestration.md §5.6) --------
// Each route below is a thin pass-through to a built `HostAdmin` method — the
// registry data model, admission and the digest-diff promotion gate already exist
// (registry.ts + both adapters). This surface exposes them; it adds no policy of its
// own. The `deploy` route (the uploader) is deliberately absent — that is Phase 2.

const rejectVersionBody = z.object({ note: z.string().min(1) });

const promoteVersionBody = z.object({
  versionId: z.string().min(1),
  // The two human checkpoints: promotion refuses a changed permission/migration
  // digest unless the matching flag is set. Optional because an unchanged digest
  // needs no acknowledgement.
  acknowledge: promotionAcknowledgement.optional(),
});

const bindScopeVersionBody = z.object({ versionId: z.string().min(1) });

const listRolesQuery = z.object({
  tenantId: tenantIdSchema.optional(),
  // Free-form: a module id or 'vertical'. Not narrowed to the source union here
  // — an unknown source should return nothing, not 400. The console offers only
  // sources it has seen.
  source: z.string().optional(),
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

  app.get('/tenants', async (c) => c.json(await admin.listTenants(c.get('actor'))));

  app.post('/tenants', async (c) => {
    const input = createTenantInput.parse(await c.req.json());
    await admin.createTenant(c.get('actor'), input);
    // Idempotent (§4.1): re-creating an existing tenant is a no-op, not an error,
    // so this reads back rather than reporting a create that may not have happened.
    return c.json(await admin.getTenant(c.get('actor'), input.id), 201);
  });

  app.get('/tenants/:tenantId', async (c) => {
    const tenantId = tenantIdSchema.parse(c.req.param('tenantId'));
    const tenant = await admin.getTenant(c.get('actor'), tenantId);
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
    return c.json(await admin.getTenant(c.get('actor'), tenantId));
  });

  // -- entitlements (§4.3) ---------------------------------------------------

  app.get('/tenants/:tenantId/entitlements', async (c) =>
    c.json(await admin.listEntitlements(c.get('actor'), tenantIdSchema.parse(c.req.param('tenantId')))),
  );

  app.put('/tenants/:tenantId/entitlements/:key', async (c) => {
    const tenantId = tenantIdSchema.parse(c.req.param('tenantId'));
    await admin.grantEntitlement(c.get('actor'), tenantId, c.req.param('key'));
    return c.json(await admin.listEntitlements(c.get('actor'), tenantId));
  });

  app.delete('/tenants/:tenantId/entitlements/:key', async (c) => {
    const tenantId = tenantIdSchema.parse(c.req.param('tenantId'));
    await admin.revokeEntitlement(c.get('actor'), tenantId, c.req.param('key'));
    return c.json(await admin.listEntitlements(c.get('actor'), tenantId));
  });

  // -- the scope directory (§3.2/§4.2) ---------------------------------------

  app.get('/scopes', async (c) => {
    const filter = listScopesQuery.parse({
      tenantId: c.req.query('tenantId'),
      status: c.req.queries('status'),
      vertical: c.req.query('vertical'),
    });
    return c.json(await admin.listScopes(c.get('actor'), filter));
  });

  app.post('/scopes', async (c) => {
    const input = provisionScopeBody.parse(await c.req.json());
    await host.provisionScope(c.get('actor'), input as Parameters<ScopeHost['provisionScope']>[1]);
    const record = await admin.getScopeRecord(c.get('actor'), input.tenantId, input.scopeId);
    return c.json(record, 201);
  });

  app.get('/tenants/:tenantId/scopes/:scopeId', async (c) => {
    const tenantId = tenantIdSchema.parse(c.req.param('tenantId'));
    const scopeId = scopeIdSchema.parse(c.req.param('scopeId'));
    const record = await admin.getScopeRecord(c.get('actor'), tenantId, scopeId);
    // Absent, or present under another tenant — indistinguishable on purpose (K-3).
    if (!record) return c.json({ error: `unknown scope for tenant: (${tenantId}, ${scopeId})` }, 404);
    return c.json(record);
  });

  // The four lifecycle transitions, one route each — mirroring the four audited
  // actions rather than collapsing into a PATCH that would accept a target
  // status the transition graph forbids. The graph is enforced below the seam;
  // an illegal transition surfaces as a 409.
  const transitions = {
    activate: (a: PlatformActorId, t: TenantId, s: ScopeId) => admin.activateScope(a, t, s),
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
      return c.json(await admin.getScopeRecord(c.get('actor'), tenantId, scopeId));
    });
  }

  // Pin a scope to a vertical version (#31; orchestration.md §4). Refuses a
  // non-admitted version below the seam — that refusal is the registry's reason to
  // exist. A scope operation, so it keeps the scope route shape.
  app.post('/tenants/:tenantId/scopes/:scopeId/version', async (c) => {
    const tenantId = tenantIdSchema.parse(c.req.param('tenantId'));
    const scopeId = scopeIdSchema.parse(c.req.param('scopeId'));
    const { versionId } = bindScopeVersionBody.parse(await c.req.json());
    await admin.bindScopeVersion(c.get('actor'), tenantId, scopeId, versionId);
    return c.json(await admin.getScopeRecord(c.get('actor'), tenantId, scopeId));
  });

  // -- instances (K-31) -------------------------------------------------------
  // The one place this surface calls OUT rather than sitting over `HostAdmin`, and
  // it is unavoidable: only the vertical can create a usable scope DO, because the
  // DO class bundles the modules and lives in the vertical's own deployment.
  //
  // The DIRECTORY row is not written here. The console writes it after this
  // succeeds, so the ordering is vertical-then-directory: a failure leaves an
  // orphaned scope nobody can see, rather than a directory row promising a scope
  // that does not exist. `scopeStatus` has a `provisioning` state for expressing the
  // in-between properly, and it is still unused — see the PR.

  app.post('/verticals/:slug/instances', async (c) => {
    const slug = c.req.param('slug');
    // Static binding first (milestone-one shape), then the dispatch resolver for a
    // pushed vertical — the provisioning mirror of the router's verticalFor.
    const vertical =
      options.verticals?.[slug] ?? (await options.resolveVertical?.(slug, c.get('actor')));
    if (!vertical) {
      return c.json({ error: `no deployment is bound for vertical '${slug}'` }, 501);
    }
    const input = provisionInstanceBody.parse(await c.req.json());
    try {
      const instance = await vertical.provisionInstance(
        input as Parameters<VerticalClient['provisionInstance']>[0],
      );
      return c.json(instance, 201);
    } catch (e) {
      // Propagate the vertical's own status rather than collapsing it to a 500. A
      // 403 means the platform secrets do not match — a deployment error someone
      // must act on, and indistinguishable from "the vertical is broken" once it
      // has been flattened.
      if (e instanceof ControlPlaneError) {
        return c.json({ error: e.message }, e.status as ContentfulStatusCode);
      }
      throw e;
    }
  });

  // -- vertical + version registry (#31; orchestration.md §5.6) --------------
  // Thin pass-throughs to `HostAdmin`. Register a vertical, publish a version
  // (lands PENDING — a push is not a deploy), admit/reject at the checkpoints,
  // promote a channel through the digest-diff gate, pin a scope to a version. The
  // uploader that sets `deploymentRef` (the `deploy` route) is Phase 2, not here.

  app.get('/verticals', async (c) => c.json(await admin.listVerticals(c.get('actor'))));

  app.post('/verticals', async (c) => {
    const input = registerVerticalInput.parse(await c.req.json());
    await admin.registerVertical(c.get('actor'), input);
    // Idempotent on the slug (a conflicting re-register throws below the seam), so
    // read back rather than echo the request.
    const registered = (await admin.listVerticals(c.get('actor'))).find((v) => v.slug === input.slug);
    return c.json(registered, 201);
  });

  app.get('/verticals/:slug/versions', async (c) =>
    c.json(await admin.listVersions(c.get('actor'), c.req.param('slug'))),
  );

  app.post('/verticals/:slug/versions', async (c) => {
    const input = publishVersionInput.parse(await c.req.json());
    // The slug is in the path AND the body; they must agree, the same fail-closed
    // cross-check `(tenantId, scopeId)` makes (K-3) — a mismatch is a client bug, not
    // a silent publish under the wrong vertical.
    if (input.verticalSlug !== c.req.param('slug')) {
      return c.json({ error: 'verticalSlug does not match the path' }, 400);
    }
    await admin.publishVersion(c.get('actor'), input);
    const version = (await admin.listVersions(c.get('actor'), input.verticalSlug)).find(
      (v) => v.id === input.id,
    );
    return c.json(version, 201);
  });

  app.post('/verticals/:slug/versions/:id/admit', async (c) => {
    const slug = c.req.param('slug');
    const id = c.req.param('id');
    await admin.admitVersion(c.get('actor'), id);
    return c.json((await admin.listVersions(c.get('actor'), slug)).find((v) => v.id === id));
  });

  app.post('/verticals/:slug/versions/:id/reject', async (c) => {
    const slug = c.req.param('slug');
    const id = c.req.param('id');
    const { note } = rejectVersionBody.parse(await c.req.json());
    await admin.rejectVersion(c.get('actor'), id, note);
    return c.json((await admin.listVersions(c.get('actor'), slug)).find((v) => v.id === id));
  });

  app.get('/verticals/:slug/channels', async (c) =>
    c.json(await admin.listChannels(c.get('actor'), c.req.param('slug'))),
  );

  app.post('/verticals/:slug/channels/:channel/promote', async (c) => {
    const slug = c.req.param('slug');
    const channel = channelName.parse(c.req.param('channel'));
    const { versionId, acknowledge } = promoteVersionBody.parse(await c.req.json());
    // The blast-radius moment: refuses a changed digest without the acknowledgement,
    // and refuses a non-admitted version. Both are enforced below the seam and
    // surface as a 4xx through mapError, not a 500.
    await admin.promoteVersion(c.get('actor'), slug, channel, versionId, acknowledge);
    return c.json((await admin.listChannels(c.get('actor'), slug)).find((ch) => ch.channel === channel));
  });

  // The deploy seam (self-serve-deploy.md): a `substrat push` uploads a built bundle
  // here. The order is upload → record, deliberately: a failed record leaves an
  // orphaned namespace script (invisible, GC'able) rather than a directory row
  // pointing at a deployment that is not there. The version lands PENDING — a push
  // is not a deploy; admission still gates serving.
  app.post('/verticals/:slug/deploy', async (c) => {
    if (!options.deployVertical) {
      return c.json({ error: 'deploy is not configured on this control plane' }, 501);
    }
    const slug = c.req.param('slug');
    const form = await c.req.formData();
    const raw = form.get('manifest');
    if (typeof raw !== 'string') return c.json({ error: 'missing manifest part' }, 400);
    const manifest = deployManifest.parse(JSON.parse(raw));

    // §4 sandbox contract, before anything reaches the namespace.
    assertSandboxContract(manifest);

    const modules: { name: string; content: Uint8Array; contentType: string }[] = [];
    for (const [name, value] of form.entries()) {
      if (name === 'manifest') continue;
      if (value instanceof File) {
        modules.push({
          name,
          content: new Uint8Array(await value.arrayBuffer()),
          contentType: value.type || 'application/javascript+module',
        });
      }
    }
    if (!modules.some((m) => m.name === manifest.entry)) {
      return c.json({ error: `entry module '${manifest.entry}' is not among the uploaded files` }, 400);
    }

    // Mint the version id first: the deploymentRef (the dispatch script name) is keyed
    // on it, so it is CF-valid and unique per version.
    const id = ulid();
    const deploymentRef = deploymentRefFor(slug, id);
    await options.deployVertical(deploymentRef, {
      entry: manifest.entry,
      compatibilityDate: manifest.compatibilityDate,
      modules,
      doClasses: manifest.doClasses,
      bindings: manifest.bindings,
    });

    // Register-then-publish, both idempotent-ish below the seam: a first push of a
    // slug registers it; publishVersion lands the version pending with deploymentRef.
    await admin.registerVertical(c.get('actor'), {
      slug,
      name: manifest.name ?? slug,
      source: 'cli',
    });
    await admin.publishVersion(c.get('actor'), {
      id,
      verticalSlug: slug,
      version: manifest.version,
      manifestDigest: manifest.digests.manifest,
      permissionDigest: manifest.digests.permission,
      migrationDigest: manifest.digests.migration,
      deploymentRef,
    });
    const version = (await admin.listVersions(c.get('actor'), slug)).find((v) => v.id === id);
    return c.json(version, 201);
  });

  // -- the hostname map (§4.7, K-26) -----------------------------------------
  // The three STAFF actions land here. `resolveHostname` deliberately does NOT:
  // it is the router's per-request machine path, unaudited by design (K-24), and
  // putting it on the audited staff surface would either flood the log or quietly
  // create an unaudited route on a surface whose whole claim is that it is audited.
  // The router reads the directory directly; it does not come through here.

  app.get('/hostnames', async (c) => {
    const filter = listHostnamesQuery.parse({
      tenantId: c.req.query('tenantId'),
      scopeId: c.req.query('scopeId'),
    });
    return c.json(await admin.listHostnames(c.get('actor'), filter));
  });

  app.post('/hostnames', async (c) => {
    const input = bindHostnameBody.parse(await c.req.json());
    await admin.bindHostname(c.get('actor'), input);
    const bound = (await admin.listHostnames(c.get('actor'), { scopeId: input.scopeId })).find(
      (h) => h.hostname === input.hostname,
    );
    return c.json(bound, 201);
  });

  app.patch('/hostnames/:hostname/status', async (c) => {
    const { status, note } = setHostnameStatusBody.parse(await c.req.json());
    // Not path-parsed through the schema: a hostname is the path segment here, and
    // `setHostnameStatus` normalizes and 404s an unknown one below the seam.
    const name = c.req.param('hostname');
    await admin.setHostnameStatus(c.get('actor'), name, status, note);
    const row = (await admin.listHostnames(c.get('actor'), {})).find(
      (h) => h.hostname === name.toLowerCase(),
    );
    return c.json(row);
  });

  // -- roles, read only (§4.5 console item 4) --------------------------------
  // The READ lands; `defineRole` deliberately does not. Creating a role over
  // HTTP is a permission change, and the permission diff is a human checkpoint
  // (D-22/D-29) — that surface needs its own decision, not a route added because
  // the verb was adjacent.
  app.get('/roles', async (c) => {
    const filter = listRolesQuery.parse({
      tenantId: c.req.query('tenantId'),
      source: c.req.query('source'),
    });
    return c.json(await admin.listRoles(c.get('actor'), filter));
  });

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
    const entries = await admin.auditLog(c.get('actor'), filter as Parameters<typeof admin.auditLog>[1]);
    // The cursor IS the last entry's id (ULID order is chronological), so the
    // page carries its own continuation and the console never assembles one.
    return c.json({ entries, nextCursor: entries.at(-1)?.id ?? null });
  });

  return app;
}
