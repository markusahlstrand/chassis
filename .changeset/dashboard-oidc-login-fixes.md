---
'@substrat-run/dashboard': patch
---

**Fix the AuthHero OIDC login path end to end.**

Three faults surfaced bringing the Dashboard's OIDC sign-in live on `app.substrat.net`:

- **The callback swallowed every failure** (`@substrat-run/oidc-rp`): a bare `catch`
  redirected to `/?error=auth` with no trace, so a failing login was undiagnosable in
  prod. It now logs a structured `oidc.callback.failed` with the reason — and, on a
  non-2xx token exchange, the authority's own error body (the error path only, never
  the token response, so nothing secret leaks) — and `observability` is enabled on the
  dashboard worker so the log actually lands. Console/control-plane inherit the
  non-swallowing behaviour through the shared package.
- **The slug rejected OIDC subjects** (`worker.ts`): `slugFor` fed the raw subject
  (`auth0|46906645…`) into a tenant slug that forbids `|`, so every first login 400'd at
  `createTenant` during JIT bootstrap. The subject is now stripped to its slug-safe tail
  (never hit under Better Auth, whose ids were plain alphanumeric).
- **A dead identity-pool registration** (`provision.ts`): `provisionDashboard` still
  registered a `better-auth` pool — removed, now that the provider is `authhero`.
