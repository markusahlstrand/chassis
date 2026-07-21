---
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': patch
---

**`HostAdmin.listConnectorState` — the read a poll driver needs to find its own outstanding work.**

`getConnectorState(id, key)` answers "did I already do THIS one" from a deterministic key — the
dispatch-idempotency path. It cannot answer "what is still outstanding", because a poller does
not know the keys up front:

```ts
listConnectorState(id: ConnectionId, prefix?: string): Promise<{ key: string; value: unknown }[]>
```

Returns every state row for a connection, optionally narrowed to keys under `prefix`, ordered by
key. A connector records one row per dispatch under `<provider>:dispatch:<id>`, and a scheduled
sweep enumerates them (`prefix = '<provider>:dispatch:'`) to reconcile each against the provider.
Without this a sweep would have to be handed every id it might reconcile, which defeats the point
of a sweep.

A directory-local machine read, the same class as `getConnectorState` — not audited. Implemented
on both adapters (sqlite in-process; Cloudflare on the control-plane DO, prefix filtered
coordinator-side to avoid LIKE/GLOB escaping); the contract-test suite covers prefix narrowing,
ordering, the empty-match case, and per-connection isolation, so both adapters are held to the
same behaviour.

This is the enumeration half of the Scrive connector's poll path (#96): `drainDue` and the new
`sweepScriveReconciliations` both still need a *timer* to call them, which remains a deployment
concern (no cron/alarm exists yet).
