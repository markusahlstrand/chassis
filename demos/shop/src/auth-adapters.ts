import { shopProvider } from './seed.js';
import { join } from 'node:path';
import Database from 'better-sqlite3';
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
 * you can run Better Auth, the anonymous fallback, an OIDC adapter, or several.
 */
export interface AuthResult {
  principal: PrincipalId;
  tenantId: TenantId;
  scopeId: ScopeId;
  via: string; // 'better-auth' | 'public'
  display: string;
  role: string; // UI hint only ('shop-admin' | 'warehouse' | 'customer' | 'public'); the kernel still enforces
}
export interface AuthAdapter {
  id: string;
  resolve(headers: Headers): Promise<AuthResult | null>;
}

/**
 * Pre-defined logins seeded into Better Auth so you can sign in as each persona
 * (credentials go in the docs). Each links to an existing seeded principal, so
 * logging in *is* that principal — the kernel enforces exactly its permissions.
 * `role` is a UI hint for nav; new self-service signups default to 'customer'.
 */
export const PERSONAS = [
  { email: 'astrid@kallkalla.se', password: 'demo1234', name: 'Astrid Kallkälla', role: 'shop-admin', key: 'astrid' },
  { email: 'gustav@kallkalla.se', password: 'demo1234', name: 'Gustav (lager)', role: 'warehouse', key: 'gustav' },
  { email: 'elin@cafepascal.se', password: 'demo1234', name: 'Elin – Café Pascal', role: 'customer', key: 'elin' },
  { email: 'otto@kontoret.se', password: 'demo1234', name: 'Otto – Kontoret', role: 'customer', key: 'otto' },
] as const;

const roleForEmail = (email?: string | null): string =>
  PERSONAS.find((p) => p.email === email)?.role ?? 'customer';

/** Anonymous fallback: not-logged-in visitors resolve to a browse-only principal. */
export function publicAuth(world: ShopWorld): AuthAdapter {
  return {
    id: 'public',
    async resolve() {
      return {
        principal: world.public,
        tenantId: world.t1,
        scopeId: world.s1,
        via: 'public',
        display: 'Gäst',
        role: 'public',
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
        (await host.admin.resolveIdentity(world.t1, shopProvider('kallkalla'), user.id)) ??
        (await provisionShopper(host, world, user));
      return {
        principal: mapped.principal,
        tenantId: world.t1,
        scopeId: mapped.scopeId ?? world.s1,
        via: 'better-auth',
        display: user.name ?? user.email ?? 'kund',
        role: roleForEmail(user.email),
      };
    },
  };
}

/**
 * Seed a Better Auth login for each persona and bind it to that persona's
 * existing principal (idempotent). Run once at startup, after migrateAuth.
 */
export async function seedPersonaLogins(
  auth: Auth,
  host: SqliteScopeHost,
  world: ShopWorld,
  dir: string,
): Promise<void> {
  const staff = platformActorId.parse(ulid());
  const db = new Database(join(dir, 'better-auth.sqlite'), { readonly: true });
  try {
    for (const p of PERSONAS) {
      let userId: string | undefined;
      try {
        const res = await auth.api.signUpEmail({
          body: { email: p.email, password: p.password, name: p.name },
        });
        userId = res.user.id;
      } catch {
        // Already exists — look up the id from Better Auth's own store.
        userId = (db.prepare('SELECT id FROM user WHERE email = ?').get(p.email) as
          | { id: string }
          | undefined)?.id;
      }
      if (userId) {
        await host.admin.linkIdentity(staff, {
          provider: shopProvider('kallkalla'),
          externalId: userId,
          principal: world[p.key],
          tenantId: world.t1,
          scopeId: world.s1,
        });
      }
    }
  } finally {
    db.close();
  }
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
): Promise<{ principal: PrincipalId; scopeId: ScopeId | null }> {
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

  await host.admin.assignRole(staff, {
    principalId: principal,
    roleKey: 'shopper',
    node: { tenantId: world.t1, scopeId: world.s1 },
  });
  await host.admin.grant(staff, {
    principalId: principal,
    permission: SHOP_PERM.orderRead,
    node: { tenantId: world.t1, scopeId: world.s1 },
    entity: { entityType: 'customer', entityId: customer.id },
    grantedBy: world.astrid,
  });
  await host.admin.linkIdentity(staff, {
    provider: 'better-auth',
    externalId: user.id,
    principal,
    tenantId: world.t1,
    scopeId: world.s1,
  });

  return { principal, scopeId: world.s1 };
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
