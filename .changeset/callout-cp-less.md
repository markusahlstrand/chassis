---
'@substrat-run/demo-callout': minor
---

**Scope-local permissions, Phase 3b — Callout runs CP-less (docs/design/scope-local-permissions.md).**

The first vertical on the control-plane-optional host (Phase 3a): the deployed Callout worker drops its `CONTROL_PLANE` bindings entirely and evaluates permissions from each scope's own storage. It is now a **sandbox-clean, pushable vertical** — the shape an untrusted self-serve deploy takes.

- **`hostFor` builds `new CloudflareScopeHost({ scope: env.SCOPE })`** — no control plane. `/internal/provision` calls **`provisionScopeLocal`** (migrate the scope's modules, project the role table locally, grant the owner `office-admin` at scope level); the shared plane already owns the tenant/scope directory row + entitlements (the dashboard wrote them before calling), so the vertical sets up only the scope's own state.
- **The request path trusts the router-asserted node.** Lifecycle is the router's gate — it resolves the hostname against the shared directory and forwards only an active scope. The connected-mode per-request `assertScopeActive` gate is gone; there is no directory to reach.
- **Identity goes CP-less via an injectable `IdentityDirectory`.** The node demo keeps the CP-backed directory (`resolveIdentity`/`linkIdentity`) unchanged; the worker uses a **D1-user-row directory** — `user.principal_id` (migration `0002_principal_binding.sql`) holds the id→principal binding the control plane used to. First login mints a principal, grants it `technician` at scope level (works with no control plane), and writes the binding back.
- **`wrangler.jsonc` is sandbox-clean:** only `SCOPE` (its own DO) + `AUTH_DB` + `ASSETS`. No `CONTROL_PLANE` DO binding, no `CONTROL_PLANE_SVC` service binding, no `ControlPlaneDO` migration class, no control-plane vars/secrets — the bindings a pushed vertical is allowed to declare (`assertSandboxContract`).
- **Removed `/api/seed`** (the connected-mode demo seeder — every call it made now throws under the null control plane). The demo world's canonical exercise stays the self-contained SQLite scenario test; the live path is dashboard create-instance → `/internal/provision`.

Verified: `demo-callout` typechecks under both the node and worker tsconfigs, the scenario + provision suites pass (16 tests), boundary-lint + the permission snapshot hold, and `wrangler deploy --dry-run` bundles the worker for the edge with exactly `SCOPE` / `AUTH_DB` / `ASSETS`.
