# @substrat/contract-tests

The **conformance suite** for scope-host adapters. Every adapter — pure SQLite,
Cloudflare Durable Objects, and any future one — must pass this suite **unchanged,
forever**. If an adapter needs the suite modified, the contract changed, and that is a
decision, not a patch.

This is the mechanism behind the platform's central promise: the guarantees are
properties of the substrate, and here is the substrate being tested for them.

```sh
pnpm add -D @substrat/contract-tests vitest
```

## Usage

The package exports test *suites* built on [Vitest](https://vitest.dev); it runs
nothing itself. Each adapter runs the suite from its own `test/` folder:

```ts
// packages/adapter-yours/test/contract.test.ts
import { scopeHostContractSuite } from '@substrat/contract-tests';
import { YourScopeHost } from '../src/index.js';

scopeHostContractSuite('adapter-yours', async () => {
  const host = new YourScopeHost({ ... });
  return {
    host,
    cleanup: async () => host.close(),
  };
});
```

## What the suite verifies

- **Strict serialization per scope** — 10 concurrent read-await-write increments must
  land on exactly 10.
- **Structured-clone boundary** — mutating an input after `invoke()`, or a returned
  result, must never affect scope state.
- **Kernel-stamped envelopes** — tenant, scope, ULID id, and timestamp are stamped
  below the API surface.
- **PII classification enforced** — a PII-classed event without a `subjectId` is
  rejected at emit.
- **Isolation and fail-closed addressing** — writes in one scope are invisible in
  another; a mismatched `(tenantId, scopeId)` pair throws.

The suite grows with the kernel (migration journal, crash-mid-migration,
duplicate-delivery harnesses); adapters inherit new checks by upgrading.

## Why this matters to vertical builders

Even if you never write an adapter, this package is why your local test run means
something: the pure-SQLite host your CI uses and the production host your customers use
are held to identical, executable semantics. "Works locally" and "holds in production"
are the same claim, tested.
