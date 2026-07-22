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
 * The demo persona emails and the UI role hint each maps to. The node demo seeds
 * these as Better Auth logins bound to seeded principals (server.ts); the hint drives
 * nav only — the kernel still enforces the real permissions. Any email not listed
 * (a self-service signup) defaults to 'technician'.
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

/**
 * The identity binding an external (Better Auth) user id resolves to. WHERE this
 * mapping lives is the one thing that differs between the two deployments, so it is
 * injected — the adapter itself is store-agnostic:
 *
 *   - Node (a real control plane): the CP identity directory (`cpIdentityDirectory`),
 *     via `resolveIdentity`/`linkIdentity`. Unchanged behaviour.
 *   - The CP-less worker: the vertical's OWN Better Auth user row, keyed by user id
 *     (see `worker.ts`). No control plane to bind into — the identity store the
 *     sessions already live in doubles as the id→principal directory.
 */
export interface IdentityDirectory {
  /** The principal (+ its scope, if the binding pins one) this external id maps to, or null if unseen. */
  resolve(externalId: string): Promise<{ principal: PrincipalId; scopeId: ScopeId | null } | null>;
  /** Bind a freshly-minted principal to this external id (first login). */
  bind(externalId: string, principal: PrincipalId, node: DemoNode): Promise<void>;
}

/**
 * The CP-backed identity directory: the control plane's identity table is the
 * id→principal map. This is the node demo's directory — the shared-control-plane
 * behaviour, kept exactly as it was.
 */
export function cpIdentityDirectory(host: ScopeHost, node: DemoNode): IdentityDirectory {
  return {
    resolve: async (externalId) =>
      (await host.admin.resolveIdentity(node.tenantId, 'better-auth', externalId)) ?? null,
    async bind(externalId, principal, node) {
      await host.admin.linkIdentity(platformActorId.parse(ulid()), {
        provider: 'better-auth',
        externalId,
        principal,
        tenantId: node.tenantId,
        scopeId: node.scopeId,
      });
    },
  };
}

/** Better Auth: session cookie → external user → principal (via the injected directory). */
export function betterAuthAdapter(
  auth: SessionAuth,
  host: ScopeHost,
  node: DemoNode,
  directory: IdentityDirectory,
): AuthAdapter {
  return {
    id: 'better-auth',
    async resolve(headers) {
      const session = await auth.api.getSession({ headers });
      if (!session?.user) return null;
      const user = session.user;
      let mapped = await directory.resolve(user.id);
      if (!mapped) {
        // First login of a user we haven't seen: mint a principal, give it the
        // low-privilege `technician` role in the scope (a scope-level assignment —
        // it works with or without a control plane), and bind it in the directory.
        const principal = principalId.parse(ulid());
        await host.admin.assignRole(platformActorId.parse(ulid()), {
          principalId: principal,
          roleKey: 'technician',
          node: { tenantId: node.tenantId, scopeId: node.scopeId },
        });
        await directory.bind(user.id, principal, node);
        mapped = { principal, scopeId: node.scopeId };
      }
      return {
        principal: mapped.principal,
        tenantId: node.tenantId,
        scopeId: mapped.scopeId ?? node.scopeId,
        via: 'better-auth',
        display: user.name ?? user.email ?? 'användare',
        role: roleForEmail(user.email),
      };
    },
  };
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
