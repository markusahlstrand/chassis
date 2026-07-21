# Scrive (e-signing)

Turns a signature request from the [protocol engine](/engines/protocol/) into a real signing
flow at **Scrive**, authenticated with Swedish **BankID**.

::: danger This connector cannot yet complete a signature
It is `private` and unpublished on purpose. Its **outbound** half works — a request becomes a
started Scrive document — but the **inbound** half (recording the signature back) needs kernel
seams that are only now landing. See [What's missing](#what-s-missing). Do not read "documented"
as "done."
:::

## At a glance

| | |
|---|---|
| **Provider** | Scrive eSign, `se_bankid` authentication-to-sign |
| **Category** | E-signing & identity |
| **Status** | Outbound built; inbound blocked on kernel seams |
| **Package** | `@substrat-run/connector-scrive` (private, unpublished) |
| **Consumes** | `protocol.signatures-requested` |
| **Registered with** | `registerConnector('scrive', 'protocol.signatures-requested', …)` |

## What it consumes

The [protocol engine](/engines/protocol/model) emits `protocol.signatures-requested` when a
vertical freezes a document and sends it for signature. This connector only answers when the
event's `method` is `scrive` — a vertical asking for BankID through another provider emits the
same event, and this must not answer for it.

The payload it reads is **fat by design** — a connector cannot read the vertical's tables, so
everything it needs travels on the event: the template key and version, the content hash, the
bound document hash, and the parties (each with a label, a `principal` / `external` kind, and a
`primary` / `counter` signature kind).

## The credential

The connection stores Scrive's **OAuth1 personal access credentials** — four parts:

```json
{ "clientId": "…", "clientSecret": "…", "tokenId": "…", "tokenSecret": "…" }
```

sealed at rest by the host's `SecretBox`. They combine into a PLAINTEXT signature header on every
call (`oauth_signature="<clientSecret>&<tokenSecret>"`); there is no token exchange.

::: tip Verified against reality
The connector was first written for OAuth2 bearer tokens, from the docs. A live call to the
testbed rejected that immediately — Scrive's UI labels "Client credentials" and "Token
credentials" are two *halves* of one credential, not two schemes. This is the
[connector seam's](/connectors/) "green means ready to check, never verified" caveat cashing
out, and why the connector carries an opt-in test that runs against `api-testbed.scrive.com`
when credentials are present.
:::

**A personnummer is never stored.** When a party signs with BankID, their Swedish personal
number is passed *through* to Scrive on the signing request and kept nowhere: it is `direct` PII,
and the protocol engine deliberately records an opaque `DataSubjectId` as the signatory instead.
The provider needs the number; our tables must not have it.

## The flow

Given a `scrive` signature request, the connector:

1. **Renders an attestation sheet** — a one-page PDF naming the template, the parties, and the
   content hash the signature refers to. This is **not the contract**: rendering the real avtal
   belongs to the vertical that owns its content (see [What's missing](#what-s-missing)). The
   PDF writer is dependency-free and web-standard, and its text encoder *throws* on any character
   it cannot represent rather than substitute silently — PDF text is WinAnsi, where an unmapped
   character otherwise turns an em-dash into a euro sign on a document someone is about to sign.
2. **Creates the document** — `POST /api/v2/documents/new`.
3. **Attaches the file** — `POST …/setfile`. Separate from creation in Scrive's own API, which
   is what makes the no-file creation step possible.
4. **Sets the parties** — `POST …/update`, mapping each `external` party to `se_bankid` and each
   `principal` party to `standard`. An external signatory (a new hire on their first day, with no
   account) authenticates with BankID; the issuing principal need not.
5. **Sets a capability callback URL** — an unguessable secret in the path, because Scrive's
   callbacks carry **no signature to verify**, so a callback can only ever be a *hint* to re-read
   the document, never a trusted fact.
6. **Starts it** — `POST …/start`. The document is now `pending` and the parties are invited.
7. **Hands the provider's document id back** so it can be recorded against the signature request.

Retry is tuned for a contract, not a directory write: **8 attempts**, 5-second base backoff, up
to a 15-minute ceiling. Giving up on a signature after the executor default of five tries would
be giving up on a contract.

## Reaching the signature back

Once a party signs, Scrive changes the document status. Two ways to learn of it, and this
connector is built for the first:

- **Polling** — `GET /api/v2/documents/{id}/get` returns the full document and its status. This
  needs no ingress at all, which is why webhook transport
  ([#96](https://github.com/substrat-run/substrat/issues/96)) is *not* on the critical path.
- **Webhooks** — Scrive can POST on status change, but unauthenticated, so the callback URL is a
  capability and the body is never trusted. A webhook is an optimization over polling, not a
  replacement for it.

Either way, the write-back goes through the [inbound authority seam](/connectors/#the-seam-a-connector-plugs-into):
the connection opens a scope stub and records the signature as itself.

## What's missing

The reason this connector is honest rather than done. Four gaps, found by building it:

1. **Recording the provider's document id** back onto the signature request. Without it,
   at-least-once delivery means a retried dispatch creates a **second Scrive document** —
   duplicate legal paperwork to real signatories. This is the sharp one: the correctness problem
   is the *duplicated dispatch*, not the missing signature. The
   [authority seam (#97)](https://github.com/substrat-run/substrat/issues/97) unblocks it.
2. **Recording a signature.** Same seam.
3. **Connector state has no home** — even "this event → that document id" has nowhere durable to
   live outside a scope yet.
4. **No document store.** There is no place for rendered document *bytes*, which is why this
   sends an attestation sheet rather than the avtal, and why the real contract's rendering waits
   on the vertical plus a store.

Until (1) and (2) close, the connector takes its write-back callback as a **required constructor
argument** — a deployment that cannot supply one cannot use the connector. That is the honest
state of the platform, expressed in the type system rather than a comment.

## Testing without an account

`ScriveMock` implements the documented endpoints in memory, so the whole outbound lifecycle runs
without a Scrive account. What it proves is that *our shape* works — credential resolution,
egress, the document lifecycle, retry. It **cannot** prove our reading of Scrive's API is
correct, because it *is* that reading: same author, same misunderstandings, on both sides of the
call. A green suite means "ready to check against `api-testbed.scrive.com`", never "verified."
