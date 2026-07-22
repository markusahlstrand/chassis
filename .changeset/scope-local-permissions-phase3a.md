---
'@substrat-run/adapter-cloudflare': minor
---

**Scope-local permissions, Phase 3a — a control-plane-optional host (the CP-less vertical enabler).**

The reusable capability behind an untrusted / scope-local vertical (docs/design/scope-local-permissions.md): a `CloudflareScopeHost` that runs with **no control plane at all**.

- **`CloudflareScopeHostOptions.controlPlane` is now optional.** Absent, the host uses a **null-object control plane**: the hot path a served scope actually touches becomes trust-the-upstream — `validateScopeAccess` / `setMigrationState` no-op (the router already gated lifecycle + tenancy from the shared directory), `tenantHoldsEntitlement` returns `true` (the SKU was enforced on the shared plane at provision, so a scope that exists here was granted it), and audit no-ops (the shared plane owns the spine). Every other directory method throws — that surface genuinely is unavailable.
- **`provisionScopeLocal(...)`** — the entry a CP-less vertical's `/internal/provision` calls: migrate the scope's modules, project the vertical's role definitions locally, grant the owner a role at scope level, and evaluate permissions from the scope's own storage. No tenant-level tuples, no control plane.

Verified: the RPC + fan-out suites pass unchanged, plus new tests — a CP-less host serving an owner's permission from the scope alone (no control plane, entitlement trusted), denying a stranger (fail closed), and the admin directory surface throwing a clear "control plane unavailable".

Phase 3b makes Callout the first vertical to run on this — dropping its `CONTROL_PLANE` bindings, trusting the router-asserted node, and deploying into the WfP dispatch namespace.
