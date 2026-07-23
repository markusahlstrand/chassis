---
"@substrat-run/dashboard": minor
---

**Real per-app audit trail on the app overview.** The Activity panel showed demo data; it now
renders real lifecycle events — `created` / `active` / `failed` / `deleted` — recorded per app.
Crucially, a failed provision now records its **reason** (e.g. "no deployment is bound for vertical
'meridian'") to the trail instead of only flashing a toast, so you can see *why* an install failed
on the app's own page.

- New `dashboard_app_events` table (migration `0004`) + a `dashboard/app-events` read op (gated by
  the existing `dashboard:read`). The lifecycle ops append events; `mark-app-failed` takes the
  reason, threaded through from `createApp`'s failure path.
- Worker `GET /api/apps/:scopeId/events`; web `api.appEvents`; `AppDetail`'s Activity panel wired to
  it (with a `danger` timeline dot for failures, loading + empty states).

Contains a **migration** (`dashboard` `0004-app-events`) for the checkpoint review.
