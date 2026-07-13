# @substrat/contracts

Contract schemas for the [Substrat](https://github.com/markusahlstrand/chassis) kernel —
the hard parts of vertical B2B SaaS (tenancy, permissions, audit, GDPR), hosted and
enforced at runtime.

This package is the **source of truth** for every data shape that crosses a Substrat
boundary. The schemas are written in [Zod](https://zod.dev), so the reviewed artifact
*is* the runtime validator: OpenAPI and JSON Schema documents are emitted from this
package, never hand-maintained beside it.

## What's inside

- **IDs** — branded ULID types (`TenantId`, `ScopeId`, `PrincipalId`, `EventId`, …):
  opaque, sortable, and unmixable at compile time.
- **Tenancy** — `Tenant` and `Scope`: two-level today, tree-ready by design
  (`parentScopeId`), with per-scope `storageShape` and immutable `jurisdiction`.
- **Permissions** — roles @ nodes plus capability grants, and a `Decision` type where
  an allow *always* carries the grant and inheritance path that produced it.
- **Events** — the domain-event envelope. `piiClass` is required at the type level and
  a PII-classed event without a `subjectId` fails validation: crypto-shredding must
  always be able to key the erasure.
- **Module manifest** — what makes an engine self-describing: permissions, emitted and
  consumed events, migrations and skew window, attachment targets, entitlement key.

## Usage

```ts
import { scope, domainEventInput, tenantId } from '@substrat/contracts';

const s = scope.parse(row);            // validated, branded Scope
const t: TenantId = tenantId.parse(x); // a ScopeId will not typecheck here

domainEventInput.parse({
  type: 'workorder.completed',
  schemaVersion: 1,
  entity: { entityType: 'workorder', entityId: wo.id },
  piiClass: 'none',
  payload: { ... },
});
```

## Related packages

- [`@substrat/kernel`](https://npmjs.com/package/@substrat/kernel) — the behavioral
  interfaces (`ScopeHost`, `OperationContext`) built on these shapes
- [`@substrat/adapter-sqlite`](https://npmjs.com/package/@substrat/adapter-sqlite) — the
  pure-SQLite reference implementation
- [`@substrat/contract-tests`](https://npmjs.com/package/@substrat/contract-tests) — the
  conformance suite every adapter must pass

## Status

Pre-release (0.x): shapes change without notice until the first vertical ships.
