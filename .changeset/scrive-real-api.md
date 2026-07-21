---
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': patch
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/contract-tests': patch
---

**Correct the Scrive connector against the real API, and widen the connector fetch body.**

The connector was written from Scrive's docs. Driving the full lifecycle against
`api-testbed.scrive.com` exposed three things the docs left ambiguous and the docs-reading got
wrong — exactly the "a mock encodes the author's reading of the docs" caveat cashing out:

- **Auth is OAuth1 PLAINTEXT, not OAuth2 bearer.** The Scrive UI's "Client credentials" and
  "Token credentials" are two halves of one four-part signature, not two schemes. The
  connection secret shape becomes `{ clientId, clientSecret, tokenId, tokenSecret }`.
- **`POST /documents/new` returns no top-level `status`** — only `get` does. The connector now
  parses mutation responses for their id and reads status from `get`, which is the right design
  regardless (don't trust a mutation's echo).
- **`setfile` is `multipart/form-data`**, not a base64 body.

The kernel change: `ConnectorRequestInit.body` accepts `Uint8Array` as well as `string`, because
a real upload is binary and a string body corrupts the file. Web `fetch` accepts both, so the
adapters pass it straight through.

`ScriveMock` is updated to the real request encodings (OAuth1 header, form-encoded `update`,
multipart `setfile`, exactly-one-author) so it fails a connector regression rather than passing
a shape the real API rejects. A new opt-in `test/live.test.ts` drives the real lifecycle when
testbed credentials are present and skips otherwise, so CI stays offline while a local run
verifies against reality.

Still incomplete: the write-back (needs `getConnectorScope`, now available on `HostAdmin`) and a
poll driver. And `se_bankid`-to-sign is disabled on the testbed account, so the BankID
round-trip is unverified.
