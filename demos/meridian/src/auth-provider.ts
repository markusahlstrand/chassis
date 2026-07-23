/**
 * The `AuthProvider` contract — the ONLY thing the app depends on for identity.
 *
 * The application codes to this interface and does not care WHICH auth is behind it: a
 * Better Auth instance running in its own Durable Object (`auth-do.ts`), an OIDC
 * relying-party, or a test mock all satisfy it. Swapping the implementation never touches
 * the app. Two operations cover the whole surface:
 *
 *   - `handle` — the credential/session endpoints (`/api/auth/*`): sign-up, login, logout,
 *     callbacks. The worker forwards the raw request; the provider owns everything behind it.
 *   - `resolve` — turn the current request into a verified subject, or null. This is the
 *     seam the rest of the app trusts; the provider decides how (a session cookie, a bearer
 *     token, an introspection call). `sub` is the provider's stable subject id; mapping it
 *     to a Substrat `PrincipalId` is a SEPARATE, per-scope concern (not the provider's job).
 */
export interface AuthSubject {
  /** The provider's stable subject id — a Better Auth user id, an OIDC `sub`, … */
  sub: string;
  email: string | null;
  name: string | null;
}

export interface AuthProvider {
  handle(request: Request): Promise<Response>;
  resolve(headers: Headers): Promise<AuthSubject | null>;
}
