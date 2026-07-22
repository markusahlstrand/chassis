---
'@substrat-run/dashboard': minor
'@substrat-run/control-plane': patch
'@substrat-run/router': patch
'@substrat-run/demo-callout': patch
---

**The Dashboard provisions REAL, reachable apps — the tenant-narrowed authority seam (dashboard.md §4/§6).**

M0 ran apps inside the Dashboard's own deployment and bound hostnames in its own directory, so nothing it created was reachable through the router. This wires the production path: the Dashboard provisions on the SHARED control plane the router reads, narrowed to the caller's own tenant.

- **The §4 seam** (`apps/dashboard/src/authority.ts`, new) — `TenantNarrowedControlPlane`: the control-plane API over an injected `fetch` (a service binding to `substrat-control-plane`), with `tenantId` **pinned at construction** from the caller's dashboard node. The tenant is not a parameter of any method, so operation code cannot name another — cross-tenant is impossible by construction (the #97 move). Machine auth is a shared `SERVICE_TOKEN` → the control plane's service actor. Unit-tested: pins the tenant on every route, tolerates idempotent conflicts, surfaces real failures.
- **`createApp` gains a connected mode** (`provision.ts`): when a control-plane seam is present it mirrors the operator console's proven create-instance sequence — `provisionScope` (directory row) → `provisionInstance` (the vertical creates the scope + grants entitlements + assigns the owner) → `activateScope` → bind `<slug>.global.substrat.run` — so the app is a real vertical instance the router resolves. Absent the seam it keeps the M0 embedded path (tests, standalone). The permission check ("can they?") runs the same in both, first.
- **The worker** builds the seam from a new `CONTROL_PLANE_SVC` service binding + `CP_SERVICE_TOKEN` secret, pinned to the caller's tenant; falls back to embedded when unbound.
- **Reaching a vertical**: the control plane + router resolve verticals **dynamically** through the WfP dispatch namespace (`resolveVertical`/`verticalFor` → `env.DISPATCH.get(deploymentRef)`); the dashboard's connected `createApp` pins the scope to the prod version (`bindScopeVersion`) so dispatch is dynamic — no per-vertical service binding, no redeploy. `demos/callout`'s `CONTROL_PLANE_URL` is neutralized (calls go over the service binding; only the `/api` path is used).

Steps 3–4 (router, `*.global.substrat.run` DNS + ACM cert) were already live; this is step 5 — the tenant-narrowed provisioning seam. Requires a deploy of the control plane + dashboard (`CP_SERVICE_TOKEN` = the control plane's `SERVICE_TOKEN`). A vertical is instantiable once it's pushed + promoted into the dispatch namespace; making Callout the first genuinely isolated, CP-less vertical is tracked in `docs/design/scope-local-permissions.md`. Verified in code (10/10 dashboard tests, typecheck, boundary-lint, wrangler dry-runs).
