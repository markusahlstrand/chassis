import type { StaffSessionReader } from '@substrat-run/control-plane-api';
import { sessionFromHeaders, verifySession, type OidcEnv } from '@substrat-run/oidc-rp';

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

/**
 * The same staff authentication, but for a NON-browser caller (the CLI): the session
 * token arrives as `Authorization: Bearer <token>` rather than the `sb_session` cookie.
 * It is the identical signed session `verifySession` accepts — the CLI obtained it
 * through the login broker (cli-auth.ts) — so this only changes where the token is read
 * from. The roster (`d1StaffRoster`) remains the single gate, exactly as for the cookie.
 */
export function oidcStaffBearerReader(env: OidcEnv): StaffSessionReader {
  return async (headers) => {
    const header = headers.get('authorization') ?? '';
    const token = /^bearer /i.test(header) ? header.slice(7).trim() : undefined;
    const user = await verifySession(env, token);
    return user?.email ? { email: user.email } : null;
  };
}
