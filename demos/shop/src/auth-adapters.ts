import {
  platformActorId,
  principalId,
  type PrincipalId,
  type ScopeId,
  type TenantId,
} from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import type { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { SHOP_PERM } from './module.js';
import type { ShopWorld } from './seed.js';
import type { Auth } from './auth.js';

/**
 * The auth seam. `resolvePrincipal` tries each mounted adapter in order; the
 * first to recognise the request wins. The kernel never sees any of this — it
 * only ever gets a `PrincipalId`. Adapters are chosen by config (AUTH env), so
 * you can run the dev picker, Better Auth, an OIDC adapter, or several at once.
 */
export interface AuthResult {
  principal: PrincipalId;
  tenantId: TenantId;
  scopeId: ScopeId;
  via: string; // 'dev' | 'better-auth'
  display: string;
}
export interface AuthAdapter {
  id: string;
  resolve(headers: Headers): Promise<AuthResult | null>;
}

/** The dev principal-picker (`x-principal` header) — kept for staff + the persona demo. */
export function devPickerAuth(
  world: ShopWorld,
  cast: Record<string, { principal: PrincipalId; name: string }>,
): AuthAdapter {
  const nameOf = new Map(Object.values(cast).map((m) => [m.principal as string, m.name]));
  return {
    id: 'dev',
    async resolve(headers) {
      const raw = headers.get('x-principal');
      if (!raw) return null;
      let principal: PrincipalId;
      try {
        principal = principalId.parse(raw);
      } catch {
        return null;
      }
      return {
        principal,
        tenantId: world.t1,
        scopeId: world.s1,
        via: 'dev',
        display: nameOf.get(raw) ?? 'okänd',
      };
    },
  };
}

/** Better Auth: session cookie → external user → principal (via the kernel seam). */
export function betterAuthAdapter(auth: Auth, host: SqliteScopeHost, world: ShopWorld): AuthAdapter {
  return {
    id: 'better-auth',
    async resolve(headers) {
      const session = await auth.api.getSession({ headers });
      if (!session?.user) return null;
      const user = session.user;
      const mapped =
        host.admin.resolveIdentity('better-auth', user.id) ??
        (await provisionShopper(host, world, user));
      return {
        principal: mapped.principal,
        tenantId: mapped.tenantId,
        scopeId: mapped.scopeId ?? world.s1,
        via: 'better-auth',
        display: user.email ?? user.name ?? 'kund',
      };
    },
  };
}

/**
 * First login of a Better-Auth user we haven't seen: the plan's §4.3 identity
 * sync. Mint a principal, give it the `shopper` role, create its customer, grant
 * entity-narrowed order:read on that customer, and bind the identity in the
 * control-plane directory. A real signup then gets real portal isolation.
 */
async function provisionShopper(
  host: SqliteScopeHost,
  world: ShopWorld,
  user: { id: string; email?: string | null; name?: string | null },
): Promise<{ principal: PrincipalId; tenantId: TenantId; scopeId: ScopeId | null }> {
  const staff = platformActorId.parse(ulid());
  const principal = principalId.parse(ulid());

  // The customer record is created by the admin (customer:manage) — number keyed
  // off the external id so it is stable and collision-free across restarts.
  const admin = await host.getScope(world.astrid, world.t1, world.s1);
  const customer = await admin.invoke<{ id: string }>('shop/create-customer', {
    number: `W-${user.id.slice(0, 10)}`,
    name: user.name || user.email || 'Webbkund',
    orgRef: `better-auth:${user.id}`,
  });

  host.admin.assignRole(staff, {
    principalId: principal,
    roleKey: 'shopper',
    node: { tenantId: world.t1, scopeId: world.s1 },
  });
  host.admin.grant(staff, {
    principalId: principal,
    permission: SHOP_PERM.orderRead,
    node: { tenantId: world.t1, scopeId: world.s1 },
    entity: { entityType: 'customer', entityId: customer.id },
    grantedBy: world.astrid,
  });
  host.admin.linkIdentity(staff, {
    provider: 'better-auth',
    externalId: user.id,
    principal,
    tenantId: world.t1,
    scopeId: world.s1,
  });

  return { principal, tenantId: world.t1, scopeId: world.s1 };
}

/** Resolve a request to a principal across all mounted adapters; null if none match. */
export async function resolvePrincipal(
  adapters: AuthAdapter[],
  headers: Headers,
): Promise<AuthResult | null> {
  for (const a of adapters) {
    const r = await a.resolve(headers);
    if (r) return r;
  }
  return null;
}
