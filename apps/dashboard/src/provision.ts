import {
  platformActorId,
  type PermissionKey,
  type PlatformActorId,
  type PrincipalId,
  type RoleDefinition,
  type ScopeId,
  type TenantId,
} from '@substrat-run/contracts';
import { ulid, type ScopeHost } from '@substrat-run/kernel';
import { DASHBOARD_PERM, dashboardModule, type DashboardAppRow } from './module.js';
import { TenantNarrowedControlPlane } from './authority.js';

/** This vertical's slug and the DO/entitlement key it registers under. */
export const VERTICAL = 'dashboard';

export const MODULES = [dashboardModule];

/**
 * The account owner — the tenant admin. Holds the keys to provision and manage
 * apps in their own tenant. Members (a later milestone) get a narrower subset.
 */
export const ROLES: RoleDefinition[] = [
  {
    key: 'owner',
    permissions: [DASHBOARD_PERM.provisionApp, DASHBOARD_PERM.read] as PermissionKey[],
    source: 'vertical',
  },
];

/** The customer's dashboard node + who they are — everything an app action needs, all ambient. */
export interface DashboardNode {
  tenantId: TenantId;
  scopeId: ScopeId;
  principal: PrincipalId;
}

/**
 * Bootstrap ONE customer: a tenant, a dashboard scope running this vertical, and
 * the signer as its owner. This is the one action that CANNOT be tenant-narrowed
 * — there is no tenant yet — so it stays a controlled platform action, triggered
 * by sign-up behind quotas (see docs/design/dashboard.md §4). Everything after it
 * is authorized in-scope and effected against this tenant only.
 */
export async function provisionDashboard(
  host: ScopeHost,
  input: { tenantId: TenantId; scopeId: ScopeId; owner: PrincipalId; slug: string; name: string },
): Promise<DashboardNode> {
  const staff = platformActorId.parse(ulid());
  await host.admin.createTenant(staff, { id: input.tenantId, slug: input.slug, name: input.name });
  await host.admin.grantEntitlement(staff, input.tenantId, VERTICAL);
  await host.provisionScope(staff, {
    tenantId: input.tenantId,
    scopeId: input.scopeId,
    jurisdiction: 'global',
    vertical: VERTICAL,
  });
  await host.admin.activateScope(staff, input.tenantId, input.scopeId);
  for (const role of ROLES) await host.admin.defineRole(staff, input.tenantId, role);
  await host.admin.assignRole(staff, {
    principalId: input.owner,
    roleKey: 'owner',
    node: { tenantId: input.tenantId, scopeId: null },
  });
  return { tenantId: input.tenantId, scopeId: input.scopeId, principal: input.owner };
}

/**
 * Create an app — provision a new scope running `verticalSlug` **in the caller's
 * own tenant**. This is the load-bearing claim of the whole design cashed out:
 *
 * - **Authorize in-scope.** `dashboard/provision-app` runs first, and its first
 *   line is `assertAllowed(ctx.check('dashboard:provision-app'))`. The kernel
 *   decides *can they* against the caller's grants in their dashboard scope. A
 *   caller without the key is refused before anything is provisioned.
 * - **Effect tenant-narrowed.** The scope is provisioned into `node.tenantId` —
 *   the caller's OWN tenant, read from their authenticated dashboard node, **not
 *   a request argument**. There is no `tenantId` parameter a caller could set to
 *   another tenant, so cross-tenant is impossible by construction (the #97 move:
 *   authority is inherited, not re-declared).
 *
 * The `platformActorId` here effects `provisionScope` (a ScopeHost action host
 * code holds); its authority to touch THIS tenant was already decided by the
 * kernel check above, and the tenant it touches is fixed to the caller's own.
 */
export async function createApp(
  host: ScopeHost,
  input: {
    /** The caller's dashboard node — ambient, from their session. The tenant comes from HERE. */
    node: DashboardNode;
    /** The app's own scope id (minted by the caller). */
    appScopeId: ScopeId;
    /** Which vertical the app runs (catalog slug). */
    verticalSlug: string;
    name: string;
    /**
     * The SKU flags the app's modules load under (default-deny, §4.3). A single-engine
     * app has one; a composed vertical like Callout needs one per engine it runs.
     * Defaults to `[verticalSlug]`.
     */
    appEntitlements?: string[];
    /** Permissions to grant the owner INSIDE the new app scope, so they can use it. */
    appOwnerGrants?: PermissionKey[];
    /**
     * The tenant-app base domain the default hostname is minted under. The bound
     * hostname is `<slug>.<jurisdiction>.substrat.run` (K-30); overridable for tests.
     */
    baseDomain?: string;
    /**
     * CONNECTED mode (production). When present, the app is provisioned on the
     * SHARED control plane through this tenant-narrowed seam (§4) — a directory
     * row + a real vertical instance + a hostname the router can resolve — instead
     * of into this deployment's own DOs. Absent ⇒ the M0 embedded path (tests,
     * standalone), which runs the app in this deployment and binds locally.
     */
    controlPlane?: TenantNarrowedControlPlane;
    /** Display name for the tenant when it is first registered on the shared plane. */
    tenantName?: string;
  },
): Promise<DashboardAppRow> {
  // 1. Authorize + record, as the caller, in their own dashboard scope. This is the
  //    "can they?" half of §4 — the kernel's permission check, in the caller's scope
  //    — and it runs the same in both modes, before any effect.
  const scope = await host.getScope(input.node.principal, input.node.tenantId, input.node.scopeId);
  await scope.invoke('dashboard/provision-app', {
    appScopeId: input.appScopeId,
    verticalSlug: input.verticalSlug,
    name: input.name,
  });

  // 2. Effect the app scope IN THE CALLER'S OWN TENANT (node.tenantId, ambient —
  //    never a request argument). Connected: on the shared plane, tenant-narrowed.
  //    Embedded: in this deployment's own host. On failure (the vertical refused, a
  //    hostname wouldn't bind, …) mark the row `failed` so it doesn't sit silently at
  //    `provisioning`, then re-throw the original error (the caller surfaces it).
  let hostname: string | null;
  try {
    hostname = input.controlPlane
      ? await provisionOnSharedPlane(input.controlPlane, input)
      : await provisionEmbedded(host, input);
  } catch (e) {
    await scope.invoke('dashboard/mark-app-failed', { appScopeId: input.appScopeId }).catch(() => {});
    throw e;
  }

  // 3. Flip the account's record to active, recording the hostname if one bound.
  return scope.invoke('dashboard/mark-app-active', {
    appScopeId: input.appScopeId,
    ...(hostname ? { hostname } : {}),
  });
}

type CreateAppInput = Parameters<typeof createApp>[1];

/**
 * Delete an app: authorize + soft-delete the account's record, then take its scope
 * offline (the mirror of createApp). Suspend — not destroy — so it is reversible and
 * the audit history is retained; the hostname goes to `failed` so the router stops
 * resolving it. Connected: on the shared plane, tenant-narrowed. Embedded: this host.
 */
export async function deprovisionApp(
  host: ScopeHost,
  input: {
    node: DashboardNode;
    appScopeId: ScopeId;
    hostname: string | null;
    controlPlane?: TenantNarrowedControlPlane;
  },
): Promise<void> {
  // 1. Authorize + record, in the caller's own dashboard scope — the "can they?" half,
  //    exactly as createApp does, before any platform effect.
  const scope = await host.getScope(input.node.principal, input.node.tenantId, input.node.scopeId);
  await scope.invoke('dashboard/delete-app', { appScopeId: input.appScopeId });

  // 2. Take the app scope offline in the caller's own tenant (ambient, never a request arg).
  if (input.controlPlane) {
    await input.controlPlane.suspendScope(input.appScopeId);
    if (input.hostname) await input.controlPlane.setHostnameStatus(input.hostname, 'failed', 'app deleted');
  } else {
    const staff = platformActorId.parse(ulid());
    await host.admin.suspendScope(staff, input.node.tenantId, input.appScopeId);
    if (input.hostname) await host.admin.setHostnameStatus(staff, input.hostname, 'failed');
  }
}

/**
 * CONNECTED mode: provision through the shared control plane, tenant-narrowed —
 * the production path (dashboard.md §6). Mirrors the operator console's proven
 * create-instance sequence (apps/console/src/lib/create-instance.ts): a directory
 * row (`provisionScope`), the vertical instance (`provisionInstance` → the vertical
 * grants entitlements + assigns the owner its role), activation, then a bound
 * default hostname the router resolves. No `bindScopeVersion`: with WfP off the
 * router dispatches on a static `VERTICAL_<slug>` binding, which needs no version.
 */
async function provisionOnSharedPlane(cp: TenantNarrowedControlPlane, input: CreateAppInput): Promise<string | null> {
  const slug = slugify(input.name);
  const tenantSlug = `t-${cp.tenantId.toLowerCase().replace(/[^a-z0-9]/g, '').slice(-10)}`;
  await cp.ensureTenant(tenantSlug, input.tenantName ?? 'Workspace');
  // Belt-and-braces: the vertical grants these too, but an idempotent grant here
  // keeps the shared directory's entitlement view complete regardless.
  for (const key of input.appEntitlements ?? [input.verticalSlug]) await cp.grantEntitlement(key);
  await cp.provisionScope({ scopeId: input.appScopeId, slug, name: input.name, vertical: input.verticalSlug, jurisdiction: 'global' });
  await cp.provisionInstance(input.verticalSlug, { scopeId: input.appScopeId, owner: input.node.principal, slug, name: input.name });
  await cp.activateScope(input.appScopeId);

  // Pin the scope to the vertical's prod version so the router dispatches on it once
  // Workers-for-Platforms is enabled (D-35). No promoted version today ⇒ this is a
  // no-op and the router serves via the static `VERTICAL_<slug>` binding. It is the
  // ONLY thing that differs between the static bring-up and dynamic dispatch, so the
  // dashboard needs NO change when WfP flips on — only the deploy mechanism does.
  const prod = (await cp.listChannels(input.verticalSlug)).find((ch) => ch.channel === 'prod');
  if (prod) await cp.bindScopeVersion(input.appScopeId, prod.versionId);

  const base = input.baseDomain ?? 'substrat.run';
  const tail = input.appScopeId.toLowerCase().slice(-4);
  for (const hostname of [`${slug}.global.${base}`, `${slug}-${tail}.global.${base}`]) {
    try {
      await cp.bindHostname({ hostname, scopeId: input.appScopeId, surface: 'app', canonical: true });
      await cp.setHostnameStatus(hostname, 'active');
      return hostname;
    } catch {
      // Global-uniqueness collision or transient — try the next candidate.
    }
  }
  return null;
}

/** EMBEDDED mode (M0 / tests): provision into this deployment's own host + directory. */
async function provisionEmbedded(host: ScopeHost, input: CreateAppInput): Promise<string | null> {
  const staff = platformActorId.parse(ulid());
  const tenantId = input.node.tenantId;
  for (const key of input.appEntitlements ?? [input.verticalSlug]) {
    await host.admin.grantEntitlement(staff, tenantId, key);
  }
  await host.provisionScope(staff, { tenantId, scopeId: input.appScopeId, jurisdiction: 'global', vertical: input.verticalSlug });
  await host.admin.activateScope(staff, tenantId, input.appScopeId);
  for (const permission of input.appOwnerGrants ?? []) {
    await host.admin.grant(staff, {
      principalId: input.node.principal,
      permission,
      node: { tenantId, scopeId: input.appScopeId },
      grantedBy: input.node.principal,
    });
  }
  return bindDefaultHostname(host, {
    staff,
    tenantId,
    scopeId: input.appScopeId,
    name: input.name,
    jurisdiction: 'global',
    baseDomain: input.baseDomain ?? 'substrat.run',
  });
}

/** A URL-safe slug from an app name. */
function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'app'
  );
}

/**
 * Bind the scope's default hostname and mark it active, returning the bound value
 * (or null if none could be bound). `surface: 'app'` + `canonical: true` mirror the
 * console's create-instance flow; `region: null` because `global` has no regional
 * pinning. Tries the clean slug first, then a scope-tailed slug on collision.
 */
async function bindDefaultHostname(
  host: ScopeHost,
  args: { staff: PlatformActorId; tenantId: TenantId; scopeId: ScopeId; name: string; jurisdiction: string; baseDomain: string },
): Promise<string | null> {
  const base = slugify(args.name);
  const tail = args.scopeId.toLowerCase().slice(-4);
  const candidates = [
    `${base}.${args.jurisdiction}.${args.baseDomain}`,
    `${base}-${tail}.${args.jurisdiction}.${args.baseDomain}`,
  ];
  for (const hostname of candidates) {
    try {
      await host.admin.bindHostname(args.staff, {
        hostname,
        tenantId: args.tenantId,
        scopeId: args.scopeId,
        surface: 'app',
        region: null,
        canonical: true,
      });
      await host.admin.setHostnameStatus(args.staff, hostname, 'active');
      return hostname;
    } catch {
      // Collision or transient — try the next candidate.
    }
  }
  return null;
}
