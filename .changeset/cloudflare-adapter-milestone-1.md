---
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/contract-tests': patch
'@substrat-run/kernel': patch
---

Cloudflare Durable-Object adapter — milestone 1: contract suites green in workerd

The second adapter (D-14) now runs the **shared** contract suites against **real
Durable Objects** in workerd. One scope = one SQLite-backed `ScopeDO`; operations
run inside `ctx.storage.transaction(async …)` (the DO analogue of the pure
adapter's `BEGIN IMMEDIATE … COMMIT/ROLLBACK`), with per-scope serialization,
lazy migrations-on-wake, guards, entity links, and the outbox→consumer dispatch
loop. `scopeHostContractSuite` + `permissionContractSuite` pass unchanged (43
pass, 1 skip); the pure-SQLite adapter stays green.

- **contract-tests**: handlers extracted into an importable `modules.ts` so a DO
  can bundle them (a DO cannot execute closures created in another isolate);
  assertions unchanged. New `supportsRuntimeRegistration` capability flag — the
  one dynamic-late-registration test is skipped on adapters whose module set is
  code-time (CF), since a deployed DO bundle cannot gain code at runtime.
- **kernel**: `ulid()` is now **monotonic** within a process (ULID spec's
  monotonic factory) — two ids minted in the same millisecond sort in creation
  order, making the audit log's and outbox's "ULID order is chronological"
  invariant actually hold. Fixes a latent same-millisecond ordering flake.

Milestone-1 limitation, deliberately scoped: `HostAdmin` is a **synchronous**
interface, which cannot be backed by an async Durable Object — so the coordinator
holds the directory (tenants/scopes/entitlements/audit/identities/roles) in
memory and forwards only the cross-DO subset (roles + tenant tuples) to a
`ControlPlaneDO`. Making the control plane durable needs an async admin surface —
a contract evolution the second adapter surfaced (exactly what D-14 is for), and
the next step before deploying a real vertical.
