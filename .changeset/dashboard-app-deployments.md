---
"@substrat-run/dashboard": minor
---

**Real per-app Deployments tab.** The app overview's Deployments tab showed demo data; it now reads
the app's vertical version registry live — every pushed version, its admission state, which channels
point at it, and (prominently) **which version the app runs** (the `prod` channel). So "am I on
0.0.9?" is answerable: if you pushed 0.0.10 but only 0.0.9 is promoted to prod, the tab shows prod =
0.0.9 and 0.0.10 sitting admitted-but-unpromoted.

- `verticalDeploymentFromCp` / `verticalDeploymentFromHost` (by slug, so it works for a PLATFORM
  vertical the tenant doesn't "own" — unlike the tenant-level Deployments list).
- Worker `GET /api/apps/:scopeId/deployments`; web `api.appDeployments`; `AppDetail`'s Deployments
  tab wired to it (running-version banner + a real version/admission/channels table).
- Read-only: promotion for a platform vertical stays a staff action; this just surfaces the truth.

No new permission (reuses `dashboard:read`) and no migration.
