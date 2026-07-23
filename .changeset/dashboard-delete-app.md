---
'@substrat-run/dashboard': minor
---

**Delete app — real deprovisioning, replacing the front-end stub.**

"Delete app" navigated away and toasted success while doing nothing — no API call, no route, no deprovision. Now it deprovisions for real, tenant-narrowed, the mirror of create.

- **`dashboard/delete-app` operation** (migration `0002` adds a nullable `deleted_at` — soft delete, so the account's record/audit history is retained; `list-apps` hides deleted rows). Same authority as creating an app (`dashboard:provision-app`) — no new permission key.
- **`deprovisionApp`** (provision.ts): authorize + soft-delete in the caller's dashboard scope, then take the app scope **offline** — `suspendScope` (reversible, fails `getScope` closed) + the hostname → `failed` so the router stops resolving it. Connected mode goes through the tenant-narrowed control-plane seam (new `suspendScope`); embedded through the local host.
- **`DELETE /api/apps/:id`** resolves the app from the caller's *own* apps only, then deprovisions. Client `api.deleteApp(id)`; the UI awaits it and toasts success only on success (failure shows the error).

**Migration checkpoint:** `dashboard_apps` gains `deleted_at` (append-only ALTER; no enum/table rebuild).

Verified: dashboard suites pass (11), including a new scenario test — deleting an app drops it from the list and suspends its scope (`getScope` then fails closed).
