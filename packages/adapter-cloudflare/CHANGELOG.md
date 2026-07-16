# @substrat-run/adapter-cloudflare

## 0.2.1

### Patch Changes

- db77d8c: `HostAdmin` is now asynchronous

  Every `HostAdmin` method returns a `Promise` — writes (`createTenant`,
  `setTenantStatus`, the scope-lifecycle transitions, `defineRole`/`assignRole`/
  `grant`/`grantToOrg`/`addMember`, `grantEntitlement`/`revokeEntitlement`,
  `linkIdentity`) and reads (`getTenant`, `listTenants`, `listEntitlements`,
  `auditLog`, `resolveIdentity`) alike. `registerModule`/`defineOperation` stay
  synchronous (code-time bookkeeping); `getScope`/`provisionScope` were already async.

  Why: the pure adapter's synchronous admin worked only because it is in-process.
  The Cloudflare adapter (D-14) proved a durable/remote control plane — a Durable
  Object — cannot be synchronous, so the second adapter forced the interface to
  evolve. This is the two-adapter discipline doing its job. Callers now `await`
  admin calls; adapter-sqlite's methods present their synchronous SQLite work as
  Promises. Behavior, error messages, and every contract assertion are unchanged.

- ffe3be1: Cloudflare adapter: durable control plane

  The coordinator's directory is now durable. `ControlPlaneDO` grew from the two-table
  checker slice into the full directory — tenants, scopes, entitlements, the admin
  audit log, identities, roles, and tenant-level tuples all in its SQLite (DDL and
  error messages ported verbatim from the pure adapter). `CloudflareScopeHost` is now
  a thin async router: it dropped the six in-memory directory maps and the
  enqueue/drain machinery, and `await`s RPCs to the DO for every admin mutation,
  lifecycle check, and read. It keeps only code-time registration bookkeeping in
  memory and still routes scope-level tuples to the owning ScopeDO. The control plane
  now survives a coordinator restart — the prerequisite for a stateless production
  Worker. Both contract suites stay green (CF 43+1 skip, adapter-sqlite 50).

- 4ba235e: Cloudflare Durable-Object adapter — milestone 1: contract suites green in workerd

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

- Updated dependencies [db77d8c]
- Updated dependencies [4ba235e]
- Updated dependencies [d929987]
- Updated dependencies [f717014]
- Updated dependencies [6393a8e]
- Updated dependencies [2dd4175]
  - @substrat-run/kernel@0.2.1
  - @substrat-run/contracts@0.2.1
