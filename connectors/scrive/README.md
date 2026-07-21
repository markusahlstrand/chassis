# @substrat-run/connector-scrive

Scrive eSign (BankID) — the **outbound half** of external signing.

`engine-protocol` emits `protocol.signatures-requested` when a vertical freezes a document and
sends it for signature. This turns that into a Scrive document: create → set file → set parties
with `se_bankid` → start.

## ⚠️ This connector cannot complete a signature

It is `private` and unpublished on purpose. Four things are missing, none of them here:

1. **Writing back into the scope** ([#97](https://github.com/substrat-run/substrat/issues/97)).
   The provider's document id belongs on `protocol_signature_requests.external_ref`, and a
   recorded signature belongs on the instance — both in the *scope* database. Host code cannot
   write there: `ScopeHost.getScope` demands a `PrincipalId` and a connector is not one.

   The consequence is not cosmetic. Delivery is at-least-once, so **a retried dispatch creates a
   second Scrive document** — duplicate legal paperwork sent to real signatories — because
   nothing recorded that the first one exists. That is why `onDispatched` is a *required*
   option: a deployment that cannot persist the id cannot use this connector.

2. **Connector state has no home.** Even the mapping "this event → that Scrive document" has
   nowhere to live outside the scope.

3. **Nothing schedules a poll.** There is no cron trigger, queue or Durable Object alarm in any
   wrangler config. `drainDue` exists; nothing calls it on a timer.

4. **No document store.** `attachmentTargets` is declared in the manifest contract and
   implemented nowhere, so there is no place for rendered bytes.

## What it therefore sends

An **attestation sheet**, not the avtal: the template, the parties, and the content hash the
signature refers to. That is honest for a hash-attestation model and enough to exercise the
seam, but it is not a contract anybody should sign.

Rendering the real document belongs to the **vertical**, which owns the content — a connector
cannot read another module's tables and should not learn a vertical's vocabulary to try. It
needs (4) to hand the bytes over.

## Testing

`ScriveMock` implements the documented endpoints in memory, so the whole lifecycle runs without
a provider account.

**What a mock proves:** that our shape works — credential resolution, egress, health, retry,
the document lifecycle.

**What it cannot prove:** that our reading of Scrive's API is correct. The mock *is* that
reading — same author, same misunderstandings, on both sides of the call. Green here means
*ready to check against `api-testbed.scrive.com`*, never *verified*.

It stays useful afterwards: a real provider will not return 503 on demand, or let you
fast-forward two days to a signature.
