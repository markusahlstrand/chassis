import { principalId, type PrincipalId, type ScopeId, type TenantId } from '@substrat-run/contracts';
import type { ScopeHost } from '@substrat-run/kernel';

/**
 * RallyPoint's auth seam — runtime-agnostic, so it typechecks with no `node:*` or
 * `better-sqlite3` dependency. `resolvePrincipal` tries each mounted adapter in
 * order and the first to recognise the request wins. The kernel never sees any of
 * this; it only ever receives a `PrincipalId`.
 *
 * **Clubs are tenants here**, which makes this the interesting case. A padel player
 * belongs to several clubs, so the identity pool is `central` (K-23): one login,
 * one external id, a row per tenant. Resolution therefore takes the tenant as an
 * INPUT — the venue the request is for — because across per-tenant pools the same
 * external id would name different people, and the directory refuses to guess
 * (§4.3, and the reason `resolveIdentity` stopped returning a tenant in #56).
 */

/** The one method the seam needs from Better Auth. Structural, so no concrete type leaks. */
export interface SessionAuth {
  api: {
    getSession(opts: { headers: Headers }): Promise<{
      user: { id: string; email?: string | null; name?: string | null };
    } | null>;
  };
}

export interface Venue {
  label: string;
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
  resolve(headers: Headers, venue: Venue): Promise<AuthResult | null>;
}

/**
 * Better Auth: session cookie → external user → the principal that login is bound
 * to **in this venue's tenant**.
 *
 * An authenticated user with no identity in this tenant resolves to `null` rather
 * than being provisioned into one. That is the honest model for a club: signing up
 * makes you a person, it does not make you a member. Joining is what the invites
 * engine is for — someone invites you, you accept, and the connector effects the
 * membership. Auto-provisioning here would hand out club access to anyone who
 * registered an email.
 */
export function betterAuthAdapter(auth: SessionAuth, host: ScopeHost): AuthAdapter {
  return {
    id: 'better-auth',
    async resolve(headers, venue) {
      const session = await auth.api.getSession({ headers });
      if (!session?.user) return null;
      const user = session.user;
      const mapped = await host.admin.resolveIdentity(venue.tenantId, 'better-auth', user.id);
      if (!mapped) return null; // authenticated, but not a member of THIS club
      return {
        principal: mapped.principal,
        via: 'better-auth',
        display: user.name ?? user.email ?? 'spelare',
      };
    },
  };
}

/**
 * The dev-header picker: names any principal and is believed.
 *
 * An impersonation bypass by design — fine for local iteration, never a production
 * posture — so the server mounts it only when explicitly opted in. It is a
 * convenience beside real auth, not the way in.
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
  venue: Venue,
): Promise<AuthResult | null> {
  for (const a of adapters) {
    const r = await a.resolve(headers, venue);
    if (r) return r;
  }
  return null;
}
