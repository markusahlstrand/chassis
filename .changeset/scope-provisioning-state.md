---
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/contract-tests': minor
---

Scopes are provisioned as `provisioning` and activated on confirmation (K-31).

`provisionScope` wrote the directory row as `active`, so the row claimed a usable
scope before anything had built one — and only the vertical can build one, because the
DO class bundles the modules and lives in the vertical's deployment. The `provisioning`
state existed in the enum for exactly this and was unused.

`HostAdmin.activateScope` moves `provisioning → active`, through the same transition
graph the other lifecycle moves use, so it is audited and cannot revive a suspended
scope. `getScope` refuses anything not active, so an unconfirmed row is inert rather
than misleading.

`ControlPlaneClient.activateScope` is the push-mode equivalent, and the control-plane
API gains `POST /tenants/:t/scopes/:s/activate`.

Migrations are still attempted for a `provisioning` scope before it is refused, so the
lazy retry and its attempt counter survive — they are the only self-healing there is
until the reconciliation sweep exists. A scope held back by a failed migration now
reports the migration error rather than a bare "not active".
