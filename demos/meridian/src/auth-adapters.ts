import { principalId, type PrincipalId, type ScopeId, type TenantId } from '@substrat-run/contracts';
import type { ScopeHost } from '@substrat-run/kernel';

/**
 * WHERE the external (Better Auth) user id → principal binding lives is the one thing
 * that differs between Meridian's two deployments, so it is injected:
 *   - Node server (a real control plane): the CP identity directory (`cpIdentityDirectory`)
 *     via `resolveIdentity` — the central directory, unchanged.
 *   - The CP-less worker (sandbox-clean, scope-local-permissions.md Phase 3): the vertical's
 *     OWN Better Auth `user` row (`principal_id` column) IS the directory — there is no
 *     control plane to bind into. See `d1IdentityDirectory` in worker.ts.
 */
export interface IdentityDirectory {
  /** The principal this external id maps to, or null if unseen (registering ≠ becoming an employee). */
  resolve(externalId: string): Promise<PrincipalId | null>;
  /** Bind a login to a principal — how a provisioned instance's owner becomes usable (platform-gated). */
  bind(externalId: string, principal: PrincipalId): Promise<void>;
}

/**
 * Meridian's auth seam — runtime-agnostic, so it carries no `node:*` or
 * `better-sqlite3` dependency. `resolvePrincipal` tries each mounted adapter in
 * order and the first to recognise the request wins. The kernel never sees any of
 * this; it only ever receives a `PrincipalId`.
 *
 * A persona carries its own (tenant, scope) — Meridian has a second company for
 * the cross-tenant beat — so the node is per-persona rather than fixed. The tenant
 * is an INPUT to resolution either way, because that is what the directory
 * requires (§4.3): an external subject id is unique only within its pool, so "who
 * is this" has no answer without "where".
 */

/** The one method the seam needs from Better Auth. Structural, so no concrete type leaks. */
export interface SessionAuth {
  api: {
    getSession(opts: { headers: Headers }): Promise<{
      user: { id: string; email?: string | null; name?: string | null };
    } | null>;
  };
}

export interface CompanyNode {
  tenantId: TenantId;
  scopeId: ScopeId;
}

export interface AuthResult {
  principal: PrincipalId;
  via: string;
  display?: string;
}

export interface AuthAdapter {
  id: string;
  resolve(headers: Headers): Promise<AuthResult | null>;
}

/**
 * Better Auth: session cookie → external user → the principal it is bound to.
 *
 * An authenticated user with no identity here resolves to `null`. Registering an
 * email does not make you an employee, and a template that decided otherwise
 * would be teaching the wrong lesson to whoever copies it.
 */
export function betterAuthAdapter(auth: SessionAuth, directory: IdentityDirectory): AuthAdapter {
  return {
    id: 'better-auth',
    async resolve(headers) {
      const session = await auth.api.getSession({ headers });
      if (!session?.user) return null;
      const user = session.user;
      const principal = await directory.resolve(user.id);
      if (!principal) return null;
      return {
        principal,
        via: 'better-auth',
        display: user.name ?? user.email ?? 'användare',
      };
    },
  };
}

/**
 * The CP-backed identity directory — the node server's (central) behaviour: the control
 * plane's identity table is the id→principal map. `bind` uses the platform admin surface.
 */
export function cpIdentityDirectory(host: ScopeHost, node: CompanyNode): IdentityDirectory {
  return {
    resolve: async (externalId) =>
      (await host.admin.resolveIdentity(node.tenantId, 'better-auth', externalId))?.principal ?? null,
    async bind() {
      // Node-server binding goes through provisionMeridian / seedPersonaLogins' linkIdentity,
      // not this seam; a direct bind here is unused (the CP-less worker owns the bind path).
      throw new Error('cpIdentityDirectory.bind is not used — link identities via host.admin.linkIdentity');
    },
  };
}

/**
 * The dev-header picker: names any principal and is believed.
 *
 * An impersonation bypass by design — fine for local iteration, never a production
 * posture — so the server mounts it only when explicitly opted in.
 */
export function devHeaderAdapter(): AuthAdapter {
  return {
    id: 'dev-header',
    async resolve(headers) {
      const raw = headers.get('x-principal');
      if (!raw) return null;
      const parsed = principalId.safeParse(raw);
      return parsed.success ? { principal: parsed.data, via: 'dev-header' } : null;
    },
  };
}

/** First adapter to recognise the request wins; null if none do. */
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
