import {
  platformActorId,
  type PermissionKey,
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
  await host.admin.registerIdentityPool(staff, {
    provider: 'better-auth',
    topology: 'central',
    tenantId: null,
  });
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
    /** SKU the app's modules load under (defaults to the vertical slug). */
    appEntitlementKey?: string;
    /** Permissions to grant the owner INSIDE the new app scope, so they can use it. */
    appOwnerGrants?: PermissionKey[];
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
  await host.admin.grantEntitlement(staff, tenantId, input.appEntitlementKey ?? input.verticalSlug);
  await host.provisionScope(staff, {
    tenantId,
    scopeId: input.appScopeId,
    jurisdiction: 'global',
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

  // 3. Flip the account's record to active.
  return scope.invoke('dashboard/mark-app-active', { appScopeId: input.appScopeId });
}
