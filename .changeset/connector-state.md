---
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': patch
---

**Connector state, and idempotent dispatch — the Scrive connector no longer duplicates
documents on retry.**

The connector took an injected `onDispatched` callback because it had nowhere to record what
it had done. Delivery is at-least-once, so a redelivery created a *second* Scrive document —
duplicate legal paperwork to real signatories.

The obvious fix — write the dispatch record into the scope — **deadlocks**, confirmed with a
spike: a connector runs inside the scope's post-commit dispatch, and re-entering the scope
actor from there waits on the task that is waiting for it. So the ledger lives in the
**directory**, which a connector reaches through `ctx.admin` without touching the scope:

```ts
HostAdmin.putConnectorState(connectionId, key, value)
HostAdmin.getConnectorState(connectionId, key)
```

Arbitrary JSON, keyed by `(connection, key)`, in a new `_substrat_connector_state` directory
table on both adapters. Not audited — high-frequency machine state, one write per dispatch, the
same class as `recordConnectionUse`. It dies with the connection: revoke cascades.

The connector now checks the ledger before creating a document and skips if a prior dispatch is
recorded, then records the dispatch after `start`. `onDispatched` is gone. A narrow residual
window remains (ledger write fails after `start` succeeds → the retry still duplicates),
closable with provider-side dedup via the `substrat_instance` tag the connector now sets.

`getConnectorScope` (from #108) is deliberately unused here: recording a *signature* back into
the scope is the poll driver's job, where it runs as a top-level operation and re-entry is
safe. Dispatch idempotency is not a scope write and must not be one.

Contract tests on both adapters cover the state round-trip, upsert, and revoke-cascade; the
connector's own suite proves a recorded dispatch is skipped rather than repeated.
