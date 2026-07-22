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
  },
): Promise<DashboardAppRow> {
  // 1. Authorize + record, as the caller, in their own dashboard scope.
  const scope = await host.getScope(input.node.principal, input.node.tenantId, input.node.scopeId);
  await scope.invoke('dashboard/provision-app', {
    appScopeId: input.appScopeId,
    verticalSlug: input.verticalSlug,
    name: input.name,
  });

  // 2. Effect: provision the app scope IN THE CALLER'S OWN TENANT (node.tenantId,
  //    ambient — never an argument the caller supplied).
  const staff = platformActorId.parse(ulid());
  const tenantId = input.node.tenantId;
  for (const key of input.appEntitlements ?? [input.verticalSlug]) {
    await host.admin.grantEntitlement(staff, tenantId, key);
  }
  const jurisdiction = 'global' as const;
  await host.provisionScope(staff, {
    tenantId,
    scopeId: input.appScopeId,
    jurisdiction,
    vertical: input.verticalSlug,
  });
  await host.admin.activateScope(staff, tenantId, input.appScopeId);
  for (const permission of input.appOwnerGrants ?? []) {
    await host.admin.grant(staff, {
      principalId: input.node.principal,
      permission,
      node: { tenantId, scopeId: input.appScopeId },
      grantedBy: input.node.principal,
    });
  }

  // 3. Bind a default hostname `<slug>.<jurisdiction>.substrat.run` (K-30). This
  //    records the URL in the directory; it does NOT resolve until the router +
  //    DNS + ACM are in place (dashboard.md §6 steps beyond M0). Best-effort: a
  //    global-uniqueness collision must not fail an otherwise-good provision, so
  //    fall back to a scope-tailed slug, then to no hostname.
  const hostname = await bindDefaultHostname(host, {
    staff,
    tenantId,
    scopeId: input.appScopeId,
    name: input.name,
    jurisdiction,
    baseDomain: input.baseDomain ?? 'substrat.run',
  });

  // 4. Flip the account's record to active, recording the hostname if one bound.
  return scope.invoke('dashboard/mark-app-active', {
    appScopeId: input.appScopeId,
    ...(hostname ? { hostname } : {}),
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
