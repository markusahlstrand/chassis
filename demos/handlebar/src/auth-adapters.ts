import { principalId, type PrincipalId, type ScopeId, type TenantId } from '@substrat-run/contracts';
import type { ScopeHost } from '@substrat-run/kernel';

/**
 * Handlebar's auth seam — runtime-agnostic, so it carries no `node:*` or
 * `better-sqlite3` dependency. `resolvePrincipal` tries each mounted adapter in
 * order and the first to recognise the request wins. The kernel never sees any of
 * this; it only ever receives a `PrincipalId`.
 *
 * One workshop, one scope — so unlike RallyPoint the node is fixed. The tenant is
 * still an INPUT to resolution rather than something derived from the login,
 * because that is the shape the directory requires (§4.3): an external subject id
 * is unique only within its pool, so "who is this" has no answer without "where".
 */

/** The one method the seam needs from Better Auth. Structural, so no concrete type leaks. */
export interface SessionAuth {
  api: {
    getSession(opts: { headers: Headers }): Promise<{
      user: { id: string; email?: string | null; name?: string | null };
    } | null>;
  };
}

export interface ShopNode {
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
 * email does not make you staff at a bike workshop, and a template that decided
 * otherwise would be teaching the wrong lesson to whoever copies it.
 */
export function betterAuthAdapter(
  auth: SessionAuth,
  host: ScopeHost,
  node: ShopNode,
): AuthAdapter {
  return {
    id: 'better-auth',
    async resolve(headers) {
      const session = await auth.api.getSession({ headers });
      if (!session?.user) return null;
      const user = session.user;
      const mapped = await host.admin.resolveIdentity(node.tenantId, 'better-auth', user.id);
      if (!mapped) return null;
      return {
        principal: mapped.principal,
        via: 'better-auth',
        display: user.name ?? user.email ?? 'användare',
      };
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
