---
'@substrat-run/connector-scrive': patch
---

**The Scrive return path — a completed signature now records back into the scope (#97).**

The connector's outbound half was verified against the testbed; the return path — writing a
signature onto the protocol instance in the *scope* — could not be written because a signature
lives in the scope database, `getScope` demands a `PrincipalId`, and a connector is not one.
#97 (landed in the kernel/adapters) gave a connection its own door and made its authority an
ordinary permission grant, so this closes the connector's half:

```ts
reconcileScriveDispatch(host, connectionId, instanceId, { fetch })
```

It reads `documents/{id}/get`, maps each signed provider party back to its request, and records
it by invoking `protocol/record-signature` through `getConnectorScope` — the connection acting
as itself. It runs as a **top-level operation, outside any dispatch**, which is exactly what a
poll driver or callback ingress is, and where re-entering the scope is safe (dispatch
idempotency stays in the directory for the opposite reason). The connection must hold
`protocol:record-signature` (`grantToConnection`); without it the write fails closed at the
permission check, and the grant appears in the permission diff like any other.

- **Idempotent across polls.** Signed requests are remembered in the dispatch ledger, so a
  re-poll of a half-signed set records only what is newly done, and a fully-signed set records
  nothing. The instance transitions to `signed` only when every party has signed.
- **Fails closed on a party-order mismatch** rather than attributing a signature to the wrong
  request, and skips a signed party the request named no `ref` for (the connector never
  extracts the signer's personnummer).
- The dispatch ledger grew the fields the driver needs (`vertical`, `contentHash`, and per-party
  `{requestId, kind, ref}`) — none of it derivable from Scrive's document, so it is captured at
  dispatch when the event still carries it.

`sweepScriveReconciliations(host, connectionId, { fetch })` is the poll driver over it: it
enumerates the dispatch ledger (`HostAdmin.listConnectorState`, added alongside) and reconciles
every outstanding instance — skipping ones the ledger already shows complete, and stepping past a
provider error on any single instance rather than sinking the batch. Idempotent and scoped to one
connection.

Verified against `ScriveMock` advanced to `closed`; the outbound live test still passes. What a
mock cannot prove — Scrive's real `get` shape and party order — waits on a testbed BankID
round-trip (BankID-to-sign is disabled on the account).

**Still not publishable:** nothing calls the sweep on a *timer* (#96, poll path). No cron, queue
or Durable Object alarm exists in any deployment — the same trigger `drainDue` still lacks — so
`sweepScriveReconciliations` runs from a test or by hand. That trigger is a deployment concern,
not connector code, and is the remaining reason the connector stays unpublished.
