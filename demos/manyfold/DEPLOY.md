# Deploying Manyfold to the hosted platform

Manyfold is a **sandbox-clean, control-plane-less vertical** (the policy: every vertical is
sandbox-clean, only the dashboard is privileged). Its only bindings are its own `SCOPE` Durable
Object and the `AUTH` `IdentityDO`; the SPA is inlined into the worker (no `ASSETS` binding). That
is what makes it pass `assertSandboxContract` (`packages/control-plane-api/src/deploy.ts`) — a
`CONTROL_PLANE` binding or a service binding to a platform worker would be refused. So it can be
pushed into the platform's Workers-for-Platforms **dispatch namespace** and provisioned by the
shared control plane.

Until these steps are run, the dashboard catalog correctly **hides** Manyfold in connected mode
(`apps/dashboard/src/catalog.ts` → `manyfold: { connected: false }`), so nobody is offered an
install that would 501.

## What's already verified (pre-deploy)

- `pnpm --filter @substrat-run/demo-manyfold typecheck` (node + worker) · `test` (10) — green.
- `wrangler deploy --dry-run` shows **only** `SCOPE` (`ScopeDO`) + `AUTH` (`IdentityDO`) — passes
  the sandbox contract. Migration preflight: no D1 to check (DO SQLite).
- **Real workerd** (`wrangler dev`): `GET /` serves the SPA; `POST /internal/provision` is
  fail-closed (403 without `PLATFORM_SECRET`).

## Multi-scope note (the one difference from a single-scope vertical)

A Manyfold **install = one tenant with many SITES**, each its own scope/`ScopeDO`
(`idFromName(tenant, site)`). So the platform calls **`/internal/provision` once per site**
(owner granted `admin` at each). The router asserts the tenant + home site; the app selects the
active site via `x-scope`, and permissions evaluate from that site's own DO storage. Adding a site
later is another `/internal/provision` call — no redeploy.

## Prerequisites

- The control plane is configured with the `substrat-verticals` dispatch namespace and holds the
  Cloudflare API token (`createWfpUploader`) — verticals upload **through it**, not with your own
  credential (D-34).
- `@substrat-run/cli` built (`pnpm --filter @substrat-run/cli build`); you can `substrat login`.

## Auth: no D1 to create

Identity/credentials/sessions live in the per-tenant **`IdentityDO`** (its own SQLite, isolated per
tenant). No shared `AUTH_DB`. Auth is a config choice (`AUTH_PROVIDER`): default `better-auth-do`
runs Better Auth in that DO; set `AUTH_PROVIDER=oidc` + `OIDC_ISSUER` (`OIDC_AUDIENCE`) to verify a
bearer token against an OIDC issuer (AuthHero / Supabase / Auth0 / Keycloak) instead.

## Steps

1. **(nothing to set for the default provider.)** The `IdentityDO` generates its own per-tenant
   signing secret in its own storage — no `wrangler secret put`. Only for OIDC do you set vars
   (`AUTH_PROVIDER=oidc`, `OIDC_ISSUER=…`, `OIDC_AUDIENCE=…`).

2. **Push.** Runs the `build` hook (`pnpm --dir app build && gen-assets`), bundles with
   `wrangler --dry-run`, uploads to the control plane as a **PENDING** version. The platform injects
   `PLATFORM_SECRET` / `ROUTER_SECRET` on upload — you do **not** set them.

   ```sh
   substrat login
   cd demos/manyfold && substrat push     # slug/name from package.json; version auto-bumps
   substrat versions manyfold             # confirm it landed (admission: pending)
   ```

3. **Admit** the version — a human staff checkpoint (self-serve-deploy model B). An operator admits
   it in the console's Verticals view after reviewing the declared bindings. *A push is not a deploy.*

4. **Promote to prod.** `substrat promote` self-serves `dev`/`staging`; **prod is a staff decision**
   from the operator console. Once a `prod` version exists, `resolveVertical('manyfold')` finds it
   and `provisionInstance('manyfold')` succeeds.

5. **Flip the catalog flag.** In `apps/dashboard/src/catalog.ts` set `manyfold.connected = true`
   (or drop the flag), redeploy the dashboard. The marketplace now offers Manyfold and installs
   provision a real instance (one `/internal/provision` per site).

## Known follow-ups (not blockers for provisioning)

- **Multi-site install UX.** The dashboard's install flow provisions one scope today; a Manyfold
  install wants the owner to name their first site and "add site" later (each an
  `/internal/provision`). Wiring that into the install flow is the productization; provisioning
  itself already supports N sites.
- **Per-site invites** (`assignScopeRole` + the IdentityDO invite path) so an admin can add editors
  per site — the members view is read-only until then.
- **R2 asset connector** for `assetRef` uploads (the media library is the designed shell today).
