---
"@substrat-run/demo-meridian": minor
---

**Meridian is reshaped into a sandbox-clean, control-plane-less worker — the shape a vertical must have to be pushed into the platform's dispatch namespace and provisioned by the shared control plane.**

Meridian was built as a standalone worker that talked *back* to the control plane (a
`ControlPlaneDO`, a `CONTROL_PLANE_SVC` service binding, connected-mode gating, an `ASSETS`
binding, a Scrive reconcile cron). The production platform provisions verticals through a
Workers-for-Platforms **dispatch namespace**, and `assertSandboxContract` refuses a
`CONTROL_PLANE` binding or a service binding to a platform worker — so that shape could never be
pushed. This converts Meridian to the same sandbox-clean pattern Callout uses:

- **`worker.ts`** — CP-less: `hostFor` builds `CloudflareScopeHost({ scope })` (no control plane);
  `/internal/provision` sets up only the scope's own state via `provisionScopeLocal` (roles + the
  owner's `hr-admin` at scope level), since the shared plane already wrote the directory row +
  entitlements; permissions evaluate from the scope's own storage; the router asserts the node.
  Dropped: the `ControlPlaneDO`, the connected-mode `assertScopeActive` gating, and the Scrive
  connector + `scheduled()` cron.
- **CP-less identity** — the vertical's own Better Auth `user.principal_id` column is the
  id→principal directory (new `IdentityDirectory` seam + `0002_principal_binding.sql`); `/internal/link`
  binds a login to the provisioned owner. The node server keeps the central directory.
- **SPA bundled into the worker** — `scripts/gen-assets.mjs` inlines `app/dist` into
  `src/assets.generated.ts` (gitignored), served by `src/assets.ts`; the `ASSETS` binding is gone.
  gen-assets now writes only on change, so `wrangler dev`'s build hook doesn't loop on its output.
- **`wrangler.jsonc`** — sandbox-clean: only the `SCOPE` DO + `AUTH_DB`, a `build` step, no service
  binding / cron / `CONTROL_PLANE`.

Verified on real `workerd` (`wrangler dev`): `GET /` serves the SPA; `/internal/provision` is
fail-closed (403 without `PLATFORM_SECRET`, 201 with it) and provisions CP-lessly; an authenticated
`hr/*` invoke by the `hr-admin` owner succeeds on DO SQLite. `wrangler deploy --dry-run` shows only
`SCOPE` + `AUTH_DB`. All 21 node tests still pass.

Deploy steps are in `demos/meridian/DEPLOY.md` (create the D1, `substrat push`, admit, promote to
prod, flip the dashboard catalog's `connected` flag). Known follow-ups for full hosted UX: the SPA's
`/api/me`/`/api/cast` data contract (still demo-shaped), owner login-linking on first sign-in, and
Scrive reconcile (no cron on a dispatch worker).
