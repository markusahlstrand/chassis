# @substrat-run/kernel

The kernel's **behavioral seams** in pure TypeScript. This package imports no platform
APIs — Cloudflare specifics live only in adapters, and every adapter must pass the same
[conformance suite](/reference/contract-tests).

```sh
pnpm add @substrat-run/kernel @substrat-run/contracts
```

## Scope host (`scope-host.ts`)

The adapter seam. Full semantics in
[Operations & the scope host](/concepts/scope-host).

| Export | Kind | Purpose |
|---|---|---|
| `ScopeHost` | interface | `getScope`, `provisionScope`, `registerModule`, `defineOperation`, `admin`, `close` |
| `ScopeStub` | interface | the capability — the only way code outside a scope reaches it |
| `OperationContext` | interface | what a handler sees: ambient `tenantId`/`scopeId`/`principal`, `sql`, `emit`, `check`, `link` |
| `OperationHandler<I, O>` | type | `(ctx, input) => O \| Promise<O>` |
| `ConsumerHandler` | type | event consumer; at-least-once, must be idempotent |
| `ModuleRegistration` | interface | manifest + migrations + operations + consumers |
| `SqlMigration` | interface | `{ version, sql }` — ordered, journaled per module |
| `ScopedSql`, `SqlValue` | types | synchronous scope-local SQL: `query<T>()`, `exec()` |
| `ExecutorHandler` | type | `(admin, event) => void` — out-of-band host code effecting what a module asked for via an event (K-22). Registered with `registerExecutor`; receives `HostAdmin`, never `ctx`, because it acts with platform authority |
| `HostAdmin` | interface | the audited control-plane surface — enforcement input (`defineRole`, `assignRole`, `grant`, `grantToOrg`, `addMember`, `removeMember`, `listMembers`), organizations (`createOrg`, `listOrgs`, `getOrg`), identity (`registerIdentityPool`, `linkIdentity`, `resolveIdentity`, `listIdentityTenants`), tenant registry (`createTenant`, `setTenantStatus`, `listTenants`, `getTenant`), scope lifecycle (`suspendScope`, `unsuspendScope`, `archiveScope`, `unarchiveScope`), entitlements (`grantEntitlement`, `revokeEntitlement`, `listEntitlements`), and `auditLog`. Every mutation takes a `PlatformActorId` and writes an append-only audit row |
| `ProvisionScopeInput` | interface | tenant, scope, optional shape + jurisdiction (provisioned via `provisionScope(actor, input)`) |

## Permission checker (`permission-checker.ts`)

The evaluation seam — the model is kernel-owned, the engine is swappable. See
[Permissions](/concepts/permissions).

| Export | Purpose |
|---|---|
| `PermissionChecker` | `check(principal, permission, node, entity?) → Promise<Decision>` |
| `assertAllowed(decision)` | throws `PermissionDenied` unless allowed; the standard first line of an operation. Narrows the type to the proof-carrying allow. |
| `PermissionDenied` | the error class |
| `denyAllChecker` | **secure default** — denies everything |
| `UNSAFE_allowAllChecker` | test-only; grants everything via a synthetic proof tuple. The name is the warning. |

## `ulid()`

A dependency-free ULID generator — the ID scheme used everywhere
(`ids` in [`@substrat-run/contracts`](/reference/contracts)).

```ts
import { ulid } from '@substrat-run/kernel';
const id = ulid(); // '01JZX6ZH2E...'
```

## Guarantees adapters must uphold

Any `ScopeHost` implementation must provide — verified by
[`@substrat-run/contract-tests`](/reference/contract-tests):

- **Strict serialization per scope** — one operation at a time, to completion.
- **Structured-clone boundary** — inputs/results cloned both directions, even
  in-process.
- **Kernel-stamped events** — id, timestamp, tenant, scope, actor stamped below the API
  surface.
- **Fail-closed addressing** — mismatched `(tenantId, scopeId)` throws, never resolves
  elsewhere.
- **PII invariant at emit** — PII-classed events without `subjectId` are rejected.
