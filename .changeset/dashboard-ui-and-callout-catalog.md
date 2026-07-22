---
'@substrat-run/ui': minor
'@substrat-run/dashboard-web': minor
'@substrat-run/dashboard': minor
'@substrat-run/console': patch
'@substrat-run/demo-callout': patch
---

**The Dashboard UI — the tenant-facing surface, built from the design review (docs/design/dashboard-ui.md).**

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
  + ACM + control-plane `provisionInstance`), and per master-plan D-33 a demo is COPIED as a
  template, not imported.

Verified: 4/4 dashboard scenario tests (incl. a new one provisioning a real Callout scope at
`callout.global.substrat.run` and driving a live engine op), console + web typecheck, boundary-lint,
builds, `wrangler --dry-run`, and a live local worker serving the SPA + returning Callout in the
catalog.

**Remaining (beyond this PR):** the router reading the directory, `*.substrat.run` DNS + ACM cert,
and provisioning each app as a separate deployment via the control plane — until then a bound
hostname is recorded but does not yet resolve.
