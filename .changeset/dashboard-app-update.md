---
"@substrat-run/dashboard": minor
---

**Update an installed app to a newer version — and show the version it *actually* runs.**

Promoting a vertical's `prod` channel moves the channel pointer; it does **not** rebind
scopes already installed — the router dispatches on each scope's *pinned* version, set at
install time. So an app installed when prod was 0.0.9 keeps serving 0.0.9 after prod moves
to 0.0.12, with no way to move it. This closes that gap:

- **Truthful "Running"** — the Deployments tab now reads the scope's actual bound version
  (`Scope.verticalVersionId`) and marks it, instead of assuming the prod channel is what
  runs. "Am I on 0.0.9?" is now answered by what the router serves, not what prod points at.
- **"Update to latest"** — a per-app action (`POST /api/apps/:scopeId/update` → `updateApp`)
  that rebinds the scope to the vertical's current prod version and records an `updated`
  event on the Activity trail. Idempotent (a no-op when already current); authorized
  in-scope on the caller's `dashboard:provision-app` grant.

Adds migration `0005-app-updated-event` (widens the app-events `kind` CHECK to include
`updated`; table rebuild, 0004 untouched). No new permission key (reuses `provision-app`).
