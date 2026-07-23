# @substrat-run/dashboard

## 0.1.0

### Minor Changes

- 949cbb3: **Deployments view — the builder-facing mirror of the console (builder-plane.md Phase 4).**
  A customer now sees the verticals they pushed, right in their dashboard: each version's
  admission state and which channel points where, and can self-serve `dev`/`staging`
  promotion. Production stays a staff decision (model B) — shown, not actionable.

  - **`GET /api/deployments`** — the tenant's own verticals (`ownerTenant === tenant`), each
    with its versions + channels. Connected mode reads the shared control plane
    (tenant-filtered); embedded reads the local host. The tenant is the caller's own, from
    their session — never a request argument.
  - **`POST /api/deployments/:slug/promote`** — points a NON-prod channel at a version.
    `prod` is refused (403 — "promoted by the Substrat team"), and the slug is verified to be
    one of the caller's **own** deployments first (a slug you don't own reads as 404), so the
    dashboard's staff-level service token can't be used to touch another tenant's vertical.
  - **The view** (`Deployments.tsx`, a new sidebar entry) — per vertical, a version table with
    admission pills, the channels each version holds, and `→ dev` / `→ staging` buttons
    (enabled only for an admitted version). The `<tenantSlug>/` prefix is stripped for
    display; a builder sees the bare name they pushed.

  The CP client (`TenantNarrowedControlPlane`) gains `listVerticals` (tenant-filtered),
  `listVersions`, and `promote`; the assembly + ownership check live in a testable
  `deployments.ts`.

  Verified: dashboard suite (14) incl. new assertions — a tenant sees only its own verticals
  (not platform, not another tenant's), shaped with channels and newest-first versions, and a
  slug it doesn't own is not promotable; `pnpm -r typecheck` and the web build both pass.

- 847b506: **The Dashboard provisions REAL, reachable apps — the tenant-narrowed authority seam (dashboard.md §4/§6).**

  M0 ran apps inside the Dashboard's own deployment and bound hostnames in its own directory, so nothing it created was reachable through the router. This wires the production path: the Dashboard provisions on the SHARED control plane the router reads, narrowed to the caller's own tenant.

  - **The §4 seam** (`apps/dashboard/src/authority.ts`, new) — `TenantNarrowedControlPlane`: the control-plane API over an injected `fetch` (a service binding to `substrat-control-plane`), with `tenantId` **pinned at construction** from the caller's dashboard node. The tenant is not a parameter of any method, so operation code cannot name another — cross-tenant is impossible by construction (the #97 move). Machine auth is a shared `SERVICE_TOKEN` → the control plane's service actor. Unit-tested: pins the tenant on every route, tolerates idempotent conflicts, surfaces real failures.
  - **`createApp` gains a connected mode** (`provision.ts`): when a control-plane seam is present it mirrors the operator console's proven create-instance sequence — `provisionScope` (directory row) → `provisionInstance` (the vertical creates the scope + grants entitlements + assigns the owner) → `activateScope` → bind `<slug>.global.substrat.run` — so the app is a real vertical instance the router resolves. Absent the seam it keeps the M0 embedded path (tests, standalone). The permission check ("can they?") runs the same in both, first.
  - **The worker** builds the seam from a new `CONTROL_PLANE_SVC` service binding + `CP_SERVICE_TOKEN` secret, pinned to the caller's tenant; falls back to embedded when unbound.
  - **Reaching a vertical**: the control plane + router resolve verticals **dynamically** through the WfP dispatch namespace (`resolveVertical`/`verticalFor` → `env.DISPATCH.get(deploymentRef)`); the dashboard's connected `createApp` pins the scope to the prod version (`bindScopeVersion`) so dispatch is dynamic — no per-vertical service binding, no redeploy. `demos/callout`'s `CONTROL_PLANE_URL` is neutralized (calls go over the service binding; only the `/api` path is used).

  Steps 3–4 (router, `*.global.substrat.run` DNS + ACM cert) were already live; this is step 5 — the tenant-narrowed provisioning seam. Requires a deploy of the control plane + dashboard (`CP_SERVICE_TOKEN` = the control plane's `SERVICE_TOKEN`). A vertical is instantiable once it's pushed + promoted into the dispatch namespace; making Callout the first genuinely isolated, CP-less vertical is tracked in `docs/design/scope-local-permissions.md`. Verified in code (10/10 dashboard tests, typecheck, boundary-lint, wrangler dry-runs).

- 6678b4d: **Delete app — real deprovisioning, replacing the front-end stub.**

  "Delete app" navigated away and toasted success while doing nothing — no API call, no route, no deprovision. Now it deprovisions for real, tenant-narrowed, the mirror of create.

  - **`dashboard/delete-app` operation** (migration `0002` adds a nullable `deleted_at` — soft delete, so the account's record/audit history is retained; `list-apps` hides deleted rows). Same authority as creating an app (`dashboard:provision-app`) — no new permission key.
  - **`deprovisionApp`** (provision.ts): authorize + soft-delete in the caller's dashboard scope, then take the app scope **offline** — `suspendScope` (reversible, fails `getScope` closed) + the hostname → `failed` so the router stops resolving it. Connected mode goes through the tenant-narrowed control-plane seam (new `suspendScope`); embedded through the local host.
  - **`DELETE /api/apps/:id`** resolves the app from the caller's _own_ apps only, then deprovisions. Client `api.deleteApp(id)`; the UI awaits it and toasts success only on success (failure shows the error).

  **Migration checkpoint:** `dashboard_apps` gains `deleted_at` (append-only ALTER; no enum/table rebuild).

  Verified: dashboard suites pass (11), including a new scenario test — deleting an app drops it from the list and suspends its scope (`getScope` then fails closed).

- 7a64c3b: **The Dashboard — M0 of the tenant-facing self-service surface (docs/design/dashboard.md).**

  "Vercel, but for Substrat," built AS a Substrat vertical. M0 is the core self-service loop, proven
  end to end:

  - **The vertical** (`module.ts`): `dashboard:provision-app` / `dashboard:read`, a `dashboard_apps`
    table, and the ops. It owns the account's own record + permissions; it does not provision.
  - **The authority seam** (`provision.ts`): `provisionDashboard` (sign-up bootstrap) and `createApp`
    — authorizes in-scope (`dashboard/provision-app` asserts the key), then effects `provisionScope`
    into the caller's OWN tenant, read from their dashboard node, never a request argument.
    Cross-tenant is impossible by construction (the #97 move). A finding baked in: `provisionScope`
    is a `ScopeHost` action, not `HostAdmin`, so the effect lives in app-level code holding a
    `ScopeHost` — no kernel change.
  - **The worker** (`worker.ts`): Better Auth on D1; **first login bootstraps the customer's own
    tenant + dashboard scope + owner** (self-service sign-up); `GET /api/me`, `GET /api/apps`, and
    `POST /api/apps` (create an app in your tenant, from the session). A stub catalog.

  Verified: the authority unit test (owner provisions a live app in their tenant; unauthorized
  refused; cross-tenant refused even by forging the node), and the full HTTP flow on real `workerd`
  (sign up → account bootstrapped → create a running app → list), including isolation — a second
  customer gets their own tenant and sees none of the first's apps. In the permission checkpoint.

  **M0.3 — a registry-backed catalog** (`GET /api/catalog` from `listVerticals`; `ensureCatalog` seeds `registerVertical` — the same registry the operator console will use) **and a clickable SPA** (a dependency-free page: sign in → pick a vertical → create → see your apps), verified on workerd.

  **Remaining (beyond M0):** members, custom domains, connections; and the production topology — each app a separate vertical deployment provisioned via the control plane (M0 runs them in one deployment).

- 4430841: **A failed create is loud, not a silent `provisioning`.** When provisioning didn't
  complete (the vertical refused, a hostname wouldn't bind, the shared plane was
  unreachable), the app row was left at `provisioning` forever — indistinguishable from
  "still coming up".

  - **`dashboard/mark-app-failed`** op — `createApp` marks the row `failed` when the effect
    throws (guarded to only move a `provisioning` row), then re-throws the original error.
  - **The dashboard surfaces it** — `createApp` in the UI now catches, reloads (so the
    `failed` row shows), and shows an error toast with the reason instead of an unhandled
    rejection.

  Verified: dashboard suites pass (12), including a new test that a create whose effect
  throws leaves the row `failed`, not `provisioning`.

- f2428a9: **The Dashboard UI — the tenant-facing surface, built from the design review (docs/design/dashboard-ui.md).**

  "Vercel, for Substrat" as a real React app, on the same design system as the operator console.

  - **Shared `@substrat-run/ui`** — the design-system primitives (Button, Input, Table, SideNav,
    Dialog, tokens, `styles.css`, icons) EXTRACTED from `apps/console` into a source-only workspace
    package (no build step; the Vite apps transpile it). The console now re-exports it through a thin
    `components` barrel + `@import "@substrat-run/ui/styles.css"` — its `../components` import paths
    are unchanged, so this is an internal refactor with no behaviour change.
  - **`@substrat-run/dashboard-web`** — a new Vite + React SPA (`apps/dashboard/web`), hash-routed,
    every screen from the handoff: sign-in, onboarding, Apps grid/list, Create App (Git import /
    marketplace / CLI), App Detail (Overview + Deployments / Env Vars / Domains / Integrations /
    Settings tabs), Team + roles matrix, Domains, Integrations, Billing, Analytics, Settings, plus
    the ⌘K palette, notifications, an account menu, dark mode, and the shell. **M0 is wired** to the
    real worker API (`/api/me`, `/api/catalog`, `/api/apps`); M1–M3 + future screens run on demo data
    behind the design's honesty banners. A `VITE_DEV_MOCK` preview mode (mirroring the console's
    `VITE_DEV_ACTOR` seam) renders the demo tenant without OIDC; `?theme=`/`?menu=` aid screenshots.
  - **`@substrat-run/dashboard` worker** now **serves the SPA** as Workers static assets
    (`run_worker_first: ["/api/*"]` + `single-page-application` fallback) instead of the old inline
    page (deleted); `/api/me` also surfaces the signed-in email/name for the shell.
  - **The catalog offers a real Callout**, not just Documents. The worker bundles the Callout
    vertical's modules via a new worker-safe `@substrat-run/demo-callout/module` subpath (just
    `calloutModule` + `SC_PERM`, never the seed/auth) plus `workorder` + `invoicing`. `createApp`
    grants the three-engine SKU + the office-admin owner grants and **binds a default hostname**
    `<slug>.<jurisdiction>.substrat.run` (K-30 → `callout.global.substrat.run`), best-effort, recorded
    on the app row. M0 stand-in: production deploys Callout separately (dashboard.md §6 — router + DNS
    - ACM + control-plane `provisionInstance`), and per master-plan D-33 a demo is COPIED as a
      template, not imported.

  Verified: 4/4 dashboard scenario tests (incl. a new one provisioning a real Callout scope at
  `callout.global.substrat.run` and driving a live engine op), console + web typecheck, boundary-lint,
  builds, `wrangler --dry-run`, and a live local worker serving the SPA + returning Callout in the
  catalog.

  **Remaining (beyond this PR):** the router reading the directory, `*.substrat.run` DNS + ACM cert,
  and provisioning each app as a separate deployment via the control plane — until then a bound
  hostname is recorded but does not yet resolve.

- 518ea07: **Deleting an app reclaims its slug + hostname.** A failed or deleted app used to strand
  its scope slug and hostname forever — no way to reuse the name.

  - **A deleted app is now ARCHIVED, not suspended** (`deprovisionApp`): archive is the
    terminal delete state — offline (`getScope` fails closed), record retained (audit), and
    it _releases_ the name (suspend is reversible, so it keeps it).
  - **`archiveScope` is allowed from `provisioning`** (both adapters), so a scope whose
    provisioning never completed (a failed create) can be abandoned instead of stranding
    its name.
  - **Slug + hostname uniqueness ignore `archived` scopes** — the scope-slug check excludes
    archived scopes, and `bindHostname` reclaims a hostname whose holder is archived. So
    delete → recreate with the same name works, at the same `<name>.<jur>.substrat.run`.

  Verified: adapter suites (146) + dashboard suites (11) pass, including a new assertion
  that after deleting an app, a new one takes the same slug _and_ the same clean hostname.

### Patch Changes

- b4420fb: **Fix the AuthHero OIDC login path end to end.**

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

- Updated dependencies [73c0cdb]
- Updated dependencies [1dff2bd]
- Updated dependencies [f5933ec]
- Updated dependencies [9a34950]
- Updated dependencies [cc5f2ca]
- Updated dependencies [847b506]
- Updated dependencies [f2428a9]
- Updated dependencies [66e752b]
- Updated dependencies [aa786b7]
- Updated dependencies [d83f521]
- Updated dependencies [0ae7d0f]
- Updated dependencies [518ea07]
- Updated dependencies [0572a3b]
  - @substrat-run/contracts@0.12.0
  - @substrat-run/adapter-cloudflare@0.12.0
  - @substrat-run/demo-callout@0.1.0
  - @substrat-run/oidc-rp@0.1.0
  - @substrat-run/kernel@0.12.0
  - @substrat-run/engine-protocol@0.4.3
  - @substrat-run/engine-workorder@0.3.9
  - @substrat-run/engine-invoicing@0.3.9
