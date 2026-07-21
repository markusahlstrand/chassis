---
'@substrat-run/demo-meridian': patch
---

**Meridian runs on Cloudflare — the full worker port, provisionable from the portal.**

The first two stages of porting Meridian from its node/SQLite server to a deployable Cloudflare
Worker, so it can be provisioned dynamically from the control-plane portal like Callout:

- **Stage 0 — workerd-safe `provision.ts`.** `provisionMeridian`/`MODULES`/`ROLES`/`connectScrive`
  are extracted from the node-only `seed.ts` (which imports `node:fs`/`SqliteScopeHost`) into a
  `ScopeHost`-typed `provision.ts` the worker can import. `seed.ts` re-imports them; all existing
  tests still pass.
- **Stage 1 — the worker.** `src/worker.ts`: `defineScopeDO(MODULES)`, `hostFor` (modules +
  `registerScriveConnector` + a `SecretBox` when Scrive is configured), `POST /internal/provision`
  (`assertPlatformCall` → `provisionMeridian`, the K-31 handshake), a generic `/api/invoke`
  (dev-header auth for now), and a **`scheduled()` Cron handler running `runPlatformSweep`** — the
  poll-path timer the node runtime got from `setInterval` (#96), with no Callout precedent. Plus
  `tsconfig.worker.json`, `wrangler.jsonc` (DO bindings, migrations, cron), and the
  `adapter-cloudflare` + `@cloudflare/workers-types` deps.

Verified on real `workerd` (`wrangler dev`): fail-closed provisioning (403 without the platform
secret), provision (201), `hr/define-leave-type` + `hr/create-employee` + `protocol/list-templates`
(200) on DO SQLite, and the scheduled sweep (200).

The port also surfaced a real DO-portability bug: `hr_absence_ledger`'s `0001-init` had an inline
comment containing a semicolon, which the CF adapter's naive migration `split(';')` truncated
("incomplete input") — better-sqlite3 exec'd the whole blob on node and never showed it. The
comment is de-semicoloned here; the adapter splitter fragility (and the adapter divergence behind
it) is filed for a separate fix + contract test.

**Stage 2 — Better Auth on D1.** End-user identity/credentials/sessions in a Cloudflare D1
(`AUTH_DB`) via `drizzle-orm/d1` (`auth.ts` — the workerd twin of the node `auth-node.ts`), with
`auth-schema.ts` + `migrations/0001_better_auth.sql`. The worker mounts `/api/auth/*` and resolves
each request through Meridian's existing runtime-agnostic `betterAuthAdapter` (session →
`resolveIdentity` → `PrincipalId`), falling back to the gated dev-header. An authenticated user
with no linked identity resolves to nobody; `POST /internal/link` (platform-gated) binds a login
to a principal — how a provisioned instance's owner becomes usable. Verified end to end on real
`workerd`: provision → sign-up → unlinked session 401 → link → the session resolves to the owner
`via: better-auth` → an authenticated `hr/*` invoke succeeds on DO SQLite.

**Stage 3 — connected mode (portal + router wiring).** The worker now reaches the SHARED control
plane over HTTP (`ControlPlaneClient` via `CONTROL_PLANE_URL` + a `CONTROL_PLANE_SVC` service
binding), and gates every request on `assertScopeActive(tenant, scope)` — so a suspend in the
portal's console fails Meridian's next request closed across the deployment boundary. Guarded by
`STANDALONE`, so `wrangler dev` and a single-tenant box stay self-contained (no gating on a plane
that isn't running — verified: provision + invoke still 200 in standalone). The `/internal/provision`
handshake (Stage 1) is what the portal's create-instance flow calls. Adds the
`@substrat-run/control-plane-api` dep.

The router/control-plane `VERTICAL_MERIDIAN` service bindings are deliberately **not** added here:
per those configs' own comments, a vertical is bound only once its worker exists, "rather than
dangling a binding to a service that does not exist." They are deploy steps, in order:

1. Create the D1 + apply auth migration, `wrangler secret put` PLATFORM_SECRET / ROUTER_SECRET /
   SERVICE_TOKEN (matching the control plane's + router's), then `pnpm cf:deploy` this worker.
2. Add `VERTICAL_MERIDIAN → substrat-meridian` to `apps/control-plane/wrangler.jsonc` (+ its
   matching `PLATFORM_SECRET`) and `apps/router/wrangler.jsonc` (+ `ROUTER_SECRET`), and redeploy
   both. The console's create-instance flow then provisions Meridian instances, and the router
   fronts them by bound hostname.

**Stage 4 — the SPA.** The employee app (`app/dist`) is served from the same origin via an
`assets` binding with `run_worker_first` + single-page-application fallback; the worker owns
`/api/*` and `/internal/*`, everything else falls through to the SPA. `cf:dev`/`cf:deploy` build
the app first. Verified on `workerd`: `GET /` serves the app, a client route falls back to
`index.html` (200), and `/internal/provision` + `/api/invoke` stay worker-owned.

The port is complete on the code side (Stages 0-4, each verified on real `workerd`): provisioning
handshake, the Scrive connector + a `scheduled()` Cron sweep, Better Auth on D1, connected-mode
lifecycle gating, and the SPA. What remains is purely deployment — create the D1, set the secrets,
`cf:deploy`, and add the `VERTICAL_MERIDIAN` router/control-plane bindings (deploy order above).
