---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
---

**The connection store, and the first encryption primitive in the codebase.**

Per-tenant credentials for external providers had nowhere to live. `master-plan.md §6`
committed to a connection store; `kernel-design.md §1` deferred "the integrations hub beyond
its contract stub", and the stub was never written either — no `Connection` type, no
credential storage, nothing.

**Keyed on (tenant, vertical, provider)**, not tenant alone. A vertical is a blast-radius
boundary (D-30) and verticals are built by different companies (D-33), so one vendor's host
code must not reach a credential another vendor connected for the same tenant. It also
matches how OAuth issues clients. Cross-vertical sharing, if a real case ever appears, is an
explicit grant rather than the default.

**`SecretBox` is a new adapter surface** — D-18 classifies the KMS as an adapter. Before this
every `crypto.subtle` call in the repo was a one-way digest and every secret was a plaintext
Worker binding: nothing per-tenant, nothing rotatable, nothing encrypted at rest.
`webCryptoSecretBox` (AES-256-GCM, fresh IV per seal, key id for rotation) is the default;
Cloudflare Secrets Store or an external KMS drop in behind the same interface. A host with no
`SecretBox` **refuses to store a credential** rather than storing one in the clear.

Two leaks designed out rather than remembered:

- `_substrat_admin_log.before`/`after` take arbitrary JSON and the log is **append-only**, so
  a credential written there could never be removed. Connection mutations log metadata only.
- `adminAction` is a closed enum that `auditLog` parses *every* row through, so unrecognised
  actions fail the read of the whole log. Three members added.

Revoking **destroys the sealed blob** and tombstones the row: a grant that once existed is
evidence of why an access was allowed (K-21), but keeping the usable credential would make it
a liability. Uniqueness is over live rows, so a revoked connection can be replaced.

New on `HostAdmin`: `createConnection`, `listConnections`, `updateConnectionSecret`,
`revokeConnection`, `openConnection`, `recordConnectionUse`. `openConnection` takes no actor
and is not audited — the same exemption `resolveHostname` and `resolveIdentity` hold, for the
same reason: an audit row per outbound HTTP call would drown the log that matters. Health
(`lastOkAt`/`lastError`) is what an operator can act on instead.

Ten new **contract** tests, so both adapters must agree — including that the credential
appears in neither a metadata read nor the audit log, that another vertical cannot open it,
and that revoking destroys it.

**These methods take a `PlatformActorId`, which is a deliberate deferral, not an answer.**
Connecting a provider is a tenant admin's act, and routing it through a platform actor is the
defect D-31 named for `addMember`. Recorded in `docs/design/connections.md` §3.5; no console
flow should be built on this signature until the question is settled with membership's.
