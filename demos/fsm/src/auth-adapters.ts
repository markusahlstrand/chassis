import {
  platformActorId,
  principalId,
  type PrincipalId,
  type ScopeId,
  type TenantId,
} from '@substrat-run/contracts';
import { ulid, type ScopeHost } from '@substrat-run/kernel';
import { PERM as WO } from '@substrat-run/engine-workorder';
import { PROTOCOL_PERM as PROTO } from '@substrat-run/engine-protocol';

/**
 * The auth seam — runtime-agnostic, shared by BOTH entrypoints. `resolvePrincipal`
 * tries each mounted adapter in order; the first to recognise the request wins.
 * The kernel never sees any of this — it only ever gets a `PrincipalId`. Adapters
 * are chosen by config, so you can run Better Auth, the dev-header fallback, an
 * OIDC adapter, or several.
 *
 * Deliberately imports nothing runtime-specific: the host is the neutral
 * `ScopeHost` contract (`SqliteScopeHost` on Node, `CloudflareScopeHost` on the
 * edge both implement it) and the Better Auth instance is consumed through the
 * minimal structural `SessionAuth` — so this file typechecks under both the node
 * and the worker tsconfig with no `node:*` / `better-sqlite3` / `adapter-*` deps.
 */

/**
 * The one method the seam needs from a Better Auth instance: read a session from
 * request headers. Kept structural so neither the node (`better-sqlite3`) nor the
 * worker (D1/Drizzle) concrete `Auth` type leaks in here.
 */
export interface SessionAuth {
  api: {
    getSession(opts: { headers: Headers }): Promise<{
      user: { id: string; email?: string | null; name?: string | null };
    } | null>;
  };
}
export interface AuthResult {
  principal: PrincipalId;
  tenantId: TenantId;
  scopeId: ScopeId;
  via: string; // 'better-auth' | 'dev-header'
  display: string;
  role: string; // UI hint only ('office-admin' | 'technician' | 'dev'); the kernel still enforces
}
export interface AuthAdapter {
  id: string;
  resolve(headers: Headers): Promise<AuthResult | null>;
}

/** The fixed demo tenant/scope a resolved identity lands in. */
export interface DemoNode {
  tenantId: TenantId;
  scopeId: ScopeId;
}

/**
 * Pre-defined logins seeded into Better Auth so you can sign in as each persona.
 * Each links to an existing seeded principal (bound in /api/seed), so logging in
 * *is* that principal — the kernel enforces exactly its permissions. `role` is a
 * UI hint for nav; new self-service signups default to 'technician'.
 */
export const PERSONAS = [
  { email: 'anna@elmontage.se', password: 'demo1234', name: 'Anna (kontor)', role: 'office-admin', key: 'anna' },
  { email: 'harald@elmontage.se', password: 'demo1234', name: 'Harald (tekniker)', role: 'technician', key: 'harald' },
] as const;

export type PersonaKey = (typeof PERSONAS)[number]['key'];

/** The vertical-defined technician role: fill protocols and report on jobs, no signing. */
export const TECHNICIAN_ROLE = {
  key: 'technician',
  permissions: [WO.read, WO.report, PROTO.read, PROTO.fill],
  source: 'vertical' as const,
};

const roleForEmail = (email?: string | null): string =>
  PERSONAS.find((p) => p.email === email)?.role ?? 'technician';

/**
 * Dev fallback: the existing `x-principal` header picks the caller directly (no
 * credentials). Kept so the pre-auth curl tests still work. Absent header → null,
 * so Better Auth (or a 401) takes over rather than silently defaulting.
 */
export function devHeaderAdapter(node: DemoNode): AuthAdapter {
  return {
    id: 'dev-header',
    async resolve(headers) {
      const header = headers.get('x-principal');
      if (!header) return null;
      const parsed = principalId.safeParse(header);
      if (!parsed.success) return null;
      return {
        principal: parsed.data,
        tenantId: node.tenantId,
        scopeId: node.scopeId,
        via: 'dev-header',
        display: 'dev',
        role: 'dev',
      };
    },
  };
}

/** Better Auth: session cookie → external user → principal (via the kernel seam). */
export function betterAuthAdapter(auth: SessionAuth, host: ScopeHost, node: DemoNode): AuthAdapter {
  return {
    id: 'better-auth',
    async resolve(headers) {
      const session = await auth.api.getSession({ headers });
      if (!session?.user) return null;
      const user = session.user;
      const mapped =
        (await host.admin.resolveIdentity('better-auth', user.id)) ??
        (await provisionTechnician(host, node, user));
      return {
        principal: mapped.principal,
        tenantId: mapped.tenantId,
        scopeId: mapped.scopeId ?? node.scopeId,
        via: 'better-auth',
        display: user.name ?? user.email ?? 'användare',
        role: roleForEmail(user.email),
      };
    },
  };
}

/**
 * First login of a Better-Auth user we haven't seen (the plan's identity sync).
 * Mint a principal, give it the low-privilege `technician` role in the demo
 * scope, and bind the identity in the control-plane directory. A real self-service
 * signup then resolves to a real, least-privilege principal the kernel enforces.
 */
async function provisionTechnician(
  host: ScopeHost,
  node: DemoNode,
  user: { id: string; email?: string | null; name?: string | null },
): Promise<{ principal: PrincipalId; tenantId: TenantId; scopeId: ScopeId | null }> {
  const staff = platformActorId.parse(ulid());
  const principal = principalId.parse(ulid());

  await host.admin.assignRole(staff, {
    principalId: principal,
    roleKey: 'technician',
    node: { tenantId: node.tenantId, scopeId: node.scopeId },
  });
  await host.admin.linkIdentity(staff, {
    provider: 'better-auth',
    externalId: user.id,
    principal,
    tenantId: node.tenantId,
    scopeId: node.scopeId,
  });

  return { principal, tenantId: node.tenantId, scopeId: node.scopeId };
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
