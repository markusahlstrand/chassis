/**
 * The `AuthProvider` contract — the ONLY thing a vertical's app depends on for identity.
 *
 * The application codes to this interface and does not care WHICH auth is behind it: Better
 * Auth running in a per-tenant Durable Object (`identity-do.ts`), an OIDC issuer (`oidc.ts`),
 * or a test mock all satisfy it. Swapping the implementation never touches the app.
 *
 *   - `handle` — the credential/session endpoints (`/api/auth/*`): sign-up, login, logout,
 *     callbacks. The worker forwards the raw request; the provider owns what's behind it.
 *   - `resolve` — turn the current request into a verified subject, or null. `sub` is the
 *     provider's stable subject id; mapping it to a Substrat `PrincipalId` is a SEPARATE,
 *     per-scope concern (the identity directory), not the provider's job.
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
