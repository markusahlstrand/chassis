import type { StaffSessionReader } from '@substrat-run/control-plane-api';
import { sessionFromHeaders, type OidcEnv } from '@substrat-run/oidc-rp';

/**
 * The control plane's STAFF authentication on the edge: an OIDC session against the
 * platform's AuthHero instance, reduced to the provider-agnostic
 * `StaffSessionReader` the API expects. This is the seam the old Better Auth note
 * promised — "when this moves to AuthHero, only the session reader changes."
 *
 * Authentication only. Who counts as staff, and under which actor id, remains the
 * D1 staff roster (`staff-roster.ts`, #42) — this only proves the email. Anyone
 * AuthHero can authenticate gets a session cookie, but the roster refuses everyone
 * unlisted and `sessionPlatformAuth` fails closed, so the roster stays the one gate.
 *
 * workerd-safe (Web Crypto + jose, no `node:*`). Stateless: the session is the
 * signed cookie the OIDC relying party set — no auth database here anymore.
 */
export function oidcStaffSessionReader(env: OidcEnv): StaffSessionReader {
  return async (headers) => {
    const user = await sessionFromHeaders(env, headers);
    return user?.email ? { email: user.email } : null;
  };
}
