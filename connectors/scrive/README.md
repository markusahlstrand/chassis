# @substrat-run/connector-scrive

Scrive eSign (BankID) — the **outbound half** of external signing.

`engine-protocol` emits `protocol.signatures-requested` when a vertical freezes a document and
sends it for signature. This turns that into a Scrive document: create → set file → set parties
with `se_bankid` → start.

## ⚠️ This connector cannot complete a signature

It is `private` and unpublished on purpose. Four things are missing, none of them here:

1. ~~**Dispatch is not idempotent.**~~ **Done.** A redelivery once created a *second* Scrive
   document — duplicate legal paperwork to real signatories. The connector now records each
   dispatch in a directory-side ledger (`ctx.admin.putConnectorState`, keyed by the connection)
   and skips if a prior dispatch is found. Directory-side because a connector runs *inside* the
   scope's dispatch and re-entering the scope actor deadlocks (verified). A narrow residual
   remains — if the ledger write itself fails after the provider `start` succeeds, the retry
   still duplicates — closable with provider-side dedup via the `substrat_instance` tag the
   connector already sets, once a list-by-tag query lands.

2. ~~**Connector state has no home.**~~ **Done** — the ledger above is that home.

3. **Recording the signature back** ([#97](https://github.com/substrat-run/substrat/issues/97)).
   When a party signs, the signature belongs on the protocol instance in the *scope*. This is
   the poll driver's job, not the dispatch handler's: it runs as a top-level operation through
   `getConnectorScope` (the connection acting as itself), where re-entering the scope is safe.

4. **Nothing schedules a poll.** There is no cron trigger, queue or Durable Object alarm in any
   wrangler config. `drainDue` exists; nothing calls it on a timer.

5. **No document store.** `attachmentTargets` is declared in the manifest contract and
   implemented nowhere, so there is no place for rendered bytes.

## What it therefore sends

An **attestation sheet**, not the avtal: the template, the parties, and the content hash the
signature refers to. That is honest for a hash-attestation model and enough to exercise the
seam, but it is not a contract anybody should sign.

Rendering the real document belongs to the **vertical**, which owns the content — a connector
cannot read another module's tables and should not learn a vertical's vocabulary to try. It
needs (4) to hand the bytes over.

## Verified against the testbed

The API layer was **checked against `api-testbed.scrive.com`**, not just the docs — and the
first version, written from the docs, was wrong in three ways one live call exposed at once:

- **auth is OAuth1 PLAINTEXT**, not OAuth2 bearer (the UI's "Client" + "Token" credentials are
  two halves of one four-part signature; the `oauth2.scrive.com` endpoint rejects them)
- **`documents/new` returns no `status`** — only `get` does, so mutation responses are parsed
  for their id and status is re-read
- **`setfile` is `multipart/form-data`**, not a base64 body

`test/live.test.ts` runs the real lifecycle (`new → setfile → update → get`) when
`connectors/scrive/.dev.vars` holds a complete OAuth1 credential, and **skips** otherwise — so
CI without secrets stays offline and a local run with the testbed verifies the actual API. It
uses `standard` auth because **`se_bankid`-to-sign is disabled on the testbed account** (`start`
returns 409); the BankID round-trip waits on that setting.

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
