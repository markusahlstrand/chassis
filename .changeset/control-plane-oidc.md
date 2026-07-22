---
'@substrat-run/control-plane': minor
'@substrat-run/console': minor
---

**Console/control-plane staff sign-in moves from per-app Better Auth to OIDC (AuthHero).**

Second app in the platform's auth consolidation (the Dashboard was the pilot). The
OIDC relying party is now a shared package — `@substrat-run/oidc-rp` — so the
security-critical verifier (Authorization-Code + PKCE, ID-token/JWKS verification,
signed session cookie; jose + Web Crypto, no `node:*`) is written once and mounted
identically by both apps via `mountOidcRoutes`.

- **control-plane worker**: `/api/auth/login → /callback → /logout` (+ `/session`
  for the console) replace the Better Auth handler. Staff authentication is now an
  OIDC session reduced to the provider-agnostic `StaffSessionReader` — exactly the
  seam the old code predicted. The **staff roster stays** the authorization gate
  (`staff_actor` in D1); OIDC only proves the email, so an AuthHero user who isn't
  rostered still gets nothing (fails closed). Dropped `nodejs_compat` and the
  Better Auth D1 *schema* (the roster D1 remains). All OIDC config is secrets —
  nothing environment-specific is checked in.
- **console SPA**: sign-in is a redirect into the OIDC flow (no password field);
  `getSession` polls `/api/auth/session`; sign-out redirects to `/api/auth/logout`.
- The `#47` public-signup-gated-by-roster test is removed — under OIDC the control
  plane has no signup surface at all, so the hole cannot exist; a guard test asserts
  no sign-up endpoint is exposed.

The dev harness (`control-plane-api/dev/server.mts`) keeps Better Auth for the
optional real-auth-in-dev toggle; the primary local path is the dev actor, which is
unaffected.
