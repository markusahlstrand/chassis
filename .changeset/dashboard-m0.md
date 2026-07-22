---
'@substrat-run/demo-dashboard': minor
---

**The Dashboard — M0 of the tenant-facing self-service surface (docs/design/dashboard.md).**

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

**Remaining (M0.3+):** surface the version registry as a real catalog, a small SPA, members,
domains, and the production topology (each app a separate vertical deployment via the control plane).
