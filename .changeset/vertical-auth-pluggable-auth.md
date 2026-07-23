---
"@substrat-run/vertical-auth": minor
"@substrat-run/demo-meridian": minor
---

**Pluggable, config-selected auth for verticals — a new `@substrat-run/vertical-auth` package, and Meridian on it.**

Auth is now a config choice behind a small contract, isolated per tenant, with no shared `AUTH_DB`.

- **`@substrat-run/vertical-auth`** (new): the `AuthProvider` contract (`handle` + `resolve`); an
  OIDC provider (`oidcAuthProvider` — verifies a bearer JWT against the issuer's JWKS, covering
  Supabase, Auth0, AuthHero, Keycloak); and a per-tenant **`IdentityDO`** — Better Auth over
  `drizzle-orm/durable-sqlite` (its own SQLite, one DO per tenant) plus the provider-agnostic
  `sub → principal` directory (`setPendingOwner` / `resolvePrincipal`). Source-exported (`.`,
  `./provider`, `./oidc`).

- **Meridian** consumes it. The worker picks the provider by config (`AUTH_PROVIDER=better-auth-do`
  default, or `oidc` + `OIDC_ISSUER`/`OIDC_AUDIENCE`); the app never learns which. `/internal/provision`
  seeds the owner seat, and the first login **claims** it (the installer becomes `hr-admin`) —
  provider-agnostically. The shared D1 `AUTH_DB` and its identity directory are gone; `wrangler
  --dry-run` shows only the `SCOPE` + `AUTH` (IdentityDO) Durable Objects, so the worker still passes
  the sandbox contract and is pushable to the dispatch namespace.

Verified on real workerd (Better Auth path): provision → sign-up → invoke claims the owner seat →
`hr-admin` op succeeds → `/api/me` returns the claimed principal. OIDC verified with jose
(mint+verify): valid → subject; no token / wrong issuer / expired → null. 21 Meridian node tests pass.

Follow-ups (see `demos/meridian/DEPLOY.md`): fold the `hr/whoami` shape back into `/api/me` so the
owner lands on the Admin surface; adopt the package in Callout; remove the now-dead `src/auth.ts` /
`src/auth-schema.ts`.
