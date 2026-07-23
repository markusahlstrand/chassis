# Deploying Meridian to the hosted platform

Meridian is now a **sandbox-clean, control-plane-less vertical** (like Callout), so it can be
pushed into the platform's Workers-for-Platforms **dispatch namespace** and provisioned by the
shared control plane. Its only bindings are its own `SCOPE` Durable Object and `AUTH_DB`; the SPA
is bundled into the worker (no `ASSETS` binding). This is what makes it pass `assertSandboxContract`
(`packages/control-plane-api/src/deploy.ts`) — a `CONTROL_PLANE` binding or a service binding to a
platform worker would be refused.

Until these steps are run, the dashboard catalog correctly **hides** Meridian in connected mode
(`apps/dashboard/src/catalog.ts` → `meridian: { connected: false }`), so nobody is offered an
install that would 501.

## Prerequisites

- The control plane is already configured with the `substrat-verticals` dispatch namespace and
  holds the Cloudflare API token (`packages/control-plane-api` `createWfpUploader`) — verticals are
  uploaded through it, not with your own credential (D-34).
- `@substrat-run/cli` built (`pnpm --filter @substrat-run/cli build`), and you can `substrat login`
  to the control plane.

## Steps

1. **Create the auth D1 and apply migrations**, then set the real id in `wrangler.jsonc`
   (`d1_databases[0].database_id`, currently a placeholder):

   ```sh
   wrangler d1 create substrat-meridian-auth          # copy the returned database_id into wrangler.jsonc
   wrangler d1 migrations apply substrat-meridian-auth # applies 0001_better_auth + 0002_principal_binding
   ```

2. **Push** the vertical. This runs the `build` hook (`pnpm --dir app build && gen-assets`), bundles
   with `wrangler --dry-run`, and uploads to the control plane, landing a **PENDING** version. The
   platform injects `PLATFORM_SECRET` / `ROUTER_SECRET` on upload — you do **not** set them.

   ```sh
   substrat login
   substrat push demos/meridian --slug meridian --version 0.0.9 --name Meridian
   substrat versions meridian        # confirm the version landed (admission: pending)
   ```

3. **Admit** the version (a human checkpoint — model B). A push is not a deploy: a Substrat
   operator admits the version in the console's Verticals view (or the staff control-plane API)
   after reviewing the declared bindings.

4. **Promote to prod.** `substrat promote` self-serves `dev`/`staging`; **prod is a staff decision**
   and is promoted from the operator console. Once a `prod` version exists, the control plane's
   `resolveVertical('meridian')` finds it and `provisionInstance('meridian')` succeeds.

5. **Flip the catalog flag.** In `apps/dashboard/src/catalog.ts`, set `meridian.connected = true`
   (or drop the flag), then redeploy the dashboard. The marketplace now offers Meridian and installs
   provision a real instance.

## Verify (already done on `wrangler dev`, real workerd)

The reshaped worker was smoke-tested locally: `GET /` serves the SPA; `/internal/provision` is
fail-closed (403 without `PLATFORM_SECRET`, 201 with it) and sets up the scope CP-lessly via
`provisionScopeLocal`; an authenticated `hr/*` invoke (the owner holding `hr-admin` at scope level)
succeeds on DO SQLite. `wrangler deploy --dry-run` shows only the `SCOPE` + `AUTH_DB` bindings.

## Known follow-ups (not blockers for provisioning, but for full hosted UX)

- **App data contract.** The SPA still calls `/api/me` expecting the demo shape (`{ key, role,
  country, employeeId }`) and `/api/cast` (persona switching) — the sandbox-clean worker returns
  `{ principal, via, display }` and has no cast. A hosted, single-real-user Meridian needs `/api/me`
  to resolve the caller's role + employee record from the scope, and the cast switcher gated to dev.
- **Owner login linking.** `/internal/link` binds a Better Auth login to the provisioned owner
  principal (writes `user.principal_id`); the portal must call it when the owner first signs in, or
  provide a first-login claim flow. Until then the owner authenticates via the dev header only.
- **Scrive reconcile.** The poll-path cron cannot run as a dispatch user-worker, so Scrive e-sign
  reconciliation is not wired in the pushed worker; it remains a standalone-mode feature until a
  platform-level sweep covers dispatch verticals.
