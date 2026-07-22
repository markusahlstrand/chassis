---
'@substrat-run/adapter-cloudflare': minor
---

**Scope-local permissions, Phase 1 — the ScopeDO can evaluate permissions from its own storage (docs/design/scope-local-permissions.md).**

The read side of taking the shared control-plane DO off the request hot path. Behaviour-preserving on its own: a scope's `permission_source` defaults to `control-plane`, so the existing RPC path is used unchanged — this only makes the local path *possible*, for Phase 2 to activate.

- **`createLocalControlPlaneReader(sql)`** (`checker.ts`) — a `ControlPlaneReader` backed by two new ScopeDO tables (`_substrat_tenant_tuples`, `_substrat_roles`) instead of an RPC to the singleton directory. Returns the same rows the RPC reader does (the checker's `live()` filter still drops tombstoned/expired); an empty projection yields `[]` / `undefined`, i.e. **deny — fail closed**. A tombstoned role definition reads as absent.
- **The checker's reader is chosen per call** — `local` once a scope is projected (or whenever there is no `CONTROL_PLANE` binding to read, for a CP-less vertical), else RPC. Reading the marker is a cheap local indexed lookup; the source can flip at runtime.
- **Projection write primitives** on the ScopeDO — `projectRole`, `revokeProjectedRole`, `projectTenantTuple`, `setPermissionSource` — the surface the coordinator's fan-out will call in Phase 2.
- **`CONTROL_PLANE` is now optional** on the ScopeDO env (a projected / CP-less scope needs no binding).

Verified: the full adapter permission + scope-host contract suites pass **unchanged** (RPC parity), plus new tests proving the local reader is parity with RPC, that a tombstoned projection stops granting (K-21), and that flipping a scope to `local` with nothing projected **denies even where RPC would allow** (the load-bearing fail-closed property).
