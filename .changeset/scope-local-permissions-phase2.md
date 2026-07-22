---
'@substrat-run/adapter-cloudflare': minor
---

**Scope-local permissions, Phase 2 — projection on write (docs/design/scope-local-permissions.md).**

The write side that activates Phase 1's local reader: the coordinator projects a tenant's roles + tenant-level tuples INTO its scopes, so they evaluate permissions from their own storage and the shared control-plane DO leaves the request hot path. Behind a **default-off** flag, so behaviour is unchanged until a deployment opts in.

- **`CloudflareScopeHostOptions.scopeLocalPermissions`** (default `false`). On: every tenant-level write **fans out** the tenant's current role/tuple state into all its scopes, and a newly-provisioned scope is projected + flipped to local from the start.
- **Fan-out is a full re-sync** (`applyProjection` replaces a scope's projected set), hooked after every tenant-level mutation — `defineRole`, tenant `assignRole`/`grant`/`grantToOrg`, `addMember`/`removeMember`. Uniform, so it cannot miss a mutation type; a scope-level assignment/grant/entity write stays a local scope tuple and needs no fan-out.
- **`reconcileTenantProjection(tenantId)`** — the reconciliation sweep + the back-fill for scopes provisioned before the flag was on. Idempotent full replace, safe on a schedule or on demand; the backstop for any dropped fan-out (a revoke that didn't propagate).
- **`ControlPlaneDO.dumpTenantTuples`** — reads a tenant's full tuple set (incl tombstones) for the projection.

Consistency: scope-level grants stay synchronous + immediately consistent; only tenant-level changes are eventually consistent across a tenant's scopes (bounded by the fan-out + sweep) — the trade the RFC makes (role changes are rare, requests constant).

Verified: the RPC permission + scope-host contract suites pass **unchanged** (flag off), plus new fan-out tests — a tenant role reaching scopes that existed *before* it was assigned, scope-role confinement, org-membership + org-grant fan-out, a membership tombstone fanning out to deny, and `reconcileTenantProjection` repairing a deliberately-drifted scope.
