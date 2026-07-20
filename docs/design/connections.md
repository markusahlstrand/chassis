# The integrations hub — connections, connectors, and the executor runtime

Status: draft v0.1 · Last updated: 2026-07-20 · For review before any code

> **Relationship to canon.** Master plan §6 and the decision log rule; this document
> proposes, it doesn't decide. It exists to be reviewed against decisions 18 (the triage
> rule), 30/31 (the actor seam and what `PlatformActorId` costs), and 27 (extract at the
> second consumer) — and to sequence work that touches `packages/kernel`.

## 1. What this is, and why now

[master-plan.md §6](../master-plan.md) commits to the whole thing in one line:

> | Integrations framework | **Build** | Connection store + token refresh, connector interface,
> webhook ingress (signatures, replay protection), outbox with idempotent retries, per-tenant
> config + health. Steal Nango's interface design; own it for EU sovereignty. |

[kernel-design.md §1](kernel-design.md) then deferred it — *"the integrations hub beyond its
contract stub"* — and **even the stub was never written**. There is no `Connection` type, no
connector interface, and no credential storage anywhere in `packages/*/src`.

**The forcing function is now real.** `engine-protocol` milestone D shipped
`requestSignatures` → `recordSignature` ([engine-protocol.md §5.1](engine-protocol.md)), which
emits a fat `protocol.signatures-requested` that nothing can act on. And it is not the only
one waiting: `invoicing.underlag-exported` has been emitted at `schemaVersion: 2` since the
invoicing engine shipped ([engines/invoicing/src/index.ts:55](../../engines/invoicing/src/index.ts)),
shaped deliberately for an accounting connector that was never written.

**Two consumers, on the table today.** That matters more than convenience: D-27 says engines
are extracted at the second consumer, never designed ahead. The same discipline applies to the
connector interface — designing it against Scrive alone would be guessing. Designing it against
Scrive *and* Fortnox is extraction.

### 1.1 Placement is already decided

Not a judgement call. [master-plan.md §5.7](../master-plan.md)'s triage rule (the
"generalized" paragraph), verbatim:

> Three buckets, decided per capability: (1) **kernel-owned** — anything that is enforcement
> input or a contract (tenancy tree, directory, permission model, event schema, entitlements,
> attachment contracts, module manifest, **the integrations hub itself**); (2) **adapter** —
> infrastructure the kernel consumes, swappable behind a pure interface; (3) **connector** —
> third-party capability *tenants* use, living in the integrations hub.

So: **the hub is kernel-owned; individual connectors are not.** `connectors/scrive` is bucket
3 and lives outside `packages/kernel`. The connection store, the connector interface, and the
executor runtime are bucket 1. The KMS that protects credentials at rest is bucket 2 (D-18
names it explicitly).

This is also what the vertical prohibition rests on ([master-plan.md §4](../master-plan.md),
"Why runtime enforcement is the moat"):

> call third-party APIs raw — credentials live in the integrations hub; verticals see only the
> connector interface

enforced mechanically today by boundary-lint R3
([packages/boundary-lint/src/index.ts:238](../../packages/boundary-lint/src/index.ts)).

---

## 2. The runtime defect that comes first

**Before a connection store is worth building, the executor path has to survive a failed HTTP
call.** It currently cannot, and an outbound call to Scrive is the most likely thing in the
system to fail transiently.

`ExecutorHandler` ([scope-host.ts:142](../../packages/kernel/src/scope-host.ts)) is the only
outbound seam. Its dispatch loop
([adapter-sqlite/src/index.ts:885-914](../../packages/adapter-sqlite/src/index.ts), mirrored at
[adapter-cloudflare/src/host.ts:350-366](../../packages/adapter-cloudflare/src/host.ts)) is
`try` / `finally` with **no `catch`**:

| Property | Today |
|---|---|
| Backoff | none |
| Dead letter | none |
| Retry driver | **the next operation on that scope** — no timer, queue, cron or alarm exists |
| A handler that throws | escapes `invoke()` **after `COMMIT`** (commit `:813`, dispatch `:822`) — the caller sees a failed operation that in fact succeeded |
| A poison event | wedges permanently: `ORDER BY o.id` re-selects it first every drain, and executor *N+1* never runs while *N* throws |
| Attempt count / last error | not recorded — `_substrat_deliveries` has `error`, and executors never write it |

The asymmetry is backwards. Module **consumers** already have a v0 dead-letter
([adapter-sqlite/src/index.ts:948-958](../../packages/adapter-sqlite/src/index.ts)) with its
own comment — *"so one poison event can't wedge the loop"* — while executors, the only path
doing network I/O, have none.

### 2.1 What changes

> **Landed.** Implemented in #100 — retry state on the delivery journal, exponential
> backoff with jitter, dead-letter at `maxAttempts`, per-event and per-executor
> isolation, and `drainDue`/`executorDeadLetters` on the host contract. Both adapters,
> enforced by the shared contract suite. The remaining open piece is *scheduling*
> `drainDue` (§2.1 item 4) in a deployment.

1. **Catch.** A failing handler must not escape `invoke()`. The operation committed; the
   delivery failed. Those are different facts and the caller is owed the first one.
2. **Record the attempt.** `attempts`, `next_attempt_at`, `last_error` on the delivery journal
   (executors only — consumer semantics are unchanged).
3. **Backoff**, exponential with jitter, and a dead-letter after *N*. A dead-lettered delivery
   is a health signal, not a silent drop.
4. **A driver.** There is no queue, cron trigger or `alarm()` in any wrangler config today, and
   `alarm()` on the ScopeDO is unused. That is the natural fit on Cloudflare; the SQLite
   adapter gets an explicit `drainDue()` the harness and dev server call.
5. **Isolation.** One executor's poison event must not block the others.

### 2.2 Open question — is a failed delivery visible to the caller?

**Proposed: no.** Dispatch is post-commit and at-least-once by construction; a user whose work
order was created should not see an error because Fortnox was down. It belongs in the admin
log and a per-connection health surface (§3.7), not in the operation's result.

The cost is honest and worth naming: "it worked" becomes "it was accepted", and the user learns
about failure through a health view rather than a thrown error. That is the correct trade for
an outbox, and it is the trade the outbox was already making silently — just without anywhere
to look.

---

## 3. Connections — the store

### 3.1 What a connection is

One tenant's authorization to act against one external provider.

```
connection        id, tenant_id, VERTICAL, provider ('scrive'|'fortnox'|…), label,
                  status, external_account_ref, scopes, created_by, created_at,
                  expires_at, last_ok_at, last_error, last_error_at, revoked_at
                  UNIQUE (tenant_id, vertical, provider) WHERE revoked_at IS NULL
connection_secret connection_id, key_id, ciphertext — never in the same read path
```

Split deliberately: **metadata is readable, secret material is not.** Listing connections for
a console, checking health, and resolving "does this tenant have Scrive?" must not touch
ciphertext.

### 3.1.1 Keyed on (tenant, vertical, provider) — not on tenant alone

An earlier draft keyed on `tenant_id` alone, which would have made one connection visible to
**every vertical deployment serving that tenant**. That is wrong on three counts:

- **D-30 makes a vertical a blast-radius boundary.** One deployment per vertical exists so a
  problem in one does not reach another; a shared credential punches straight through it.
- **D-33 makes vertical builders third parties.** Verticals are built and hosted by different
  companies. Tenant-wide credentials would let vendor A's host code act against a provider
  that vendor B connected. Module code still cannot read a credential — but the connector is
  host code in that vertical's own deployment, so the boundary would be doing no work.
- **It is not how the provider issues credentials anyway.** Scrive is OAuth2 with registered
  clients: two vendors acting for one tenant each register their own client and hold their own
  tokens. A single shared row is a shape we would be inventing, not one that exists.

`vertical` is already first-class — `scopes.vertical` is a real column, `RouteTarget` carries
`verticalSlug`, and the admin log has a `vertical` target — so a connector resolves it from the
scope the event came from. No new plumbing.

**Cross-vertical sharing is therefore an explicit grant, if a real case ever appears.**
Additive, auditable, revocable, and fails closed meanwhile. Building the sharing machinery now
would be designing ahead of the second consumer, which is exactly what D-27 forbids.

The honest cost: a tenant running two Substrat verticals connects Scrive twice. Given they
would hold two OAuth clients regardless, that is the true shape rather than a tax.

### 3.2 It lives in the directory, not the scope

Three reasons, in order of force:

- A connection is **tenant-wide**, and a scope database is not. One Scrive account serves every
  scope a tenant has.
- **Module code must never read it.** K-8 and boundary-lint R3 exist precisely so a vertical
  cannot reach credentials; putting them in `ctx.sql`'s reach would undo that with a
  `SELECT`.
- The executor already holds `HostAdmin`, which is directory-side
  ([scope-host.ts:138](../../packages/kernel/src/scope-host.ts): *"It receives `HostAdmin`, not
  `ctx`: it acts with platform authority, which is precisely what module code must never
  hold"*).

### 3.3 Secrets — a new adapter surface

**There is no encryption primitive in this codebase.** Every `crypto.subtle` call today is a
one-way digest. Every secret is a plaintext Worker binding compared in constant time
([platform-call.ts:24](../../packages/kernel/src/platform-call.ts)). Nothing is per-tenant,
rotatable, or encrypted at rest.

D-18 classifies the KMS as an **adapter**, so:

```ts
/** Bucket 2. Seals per-tenant credentials; the kernel never sees plaintext at rest. */
export interface SecretBox {
  /** Returns the sealed blob plus the key id that sealed it (rotation). */
  seal(plaintext: string): Promise<{ keyId: string; sealed: string }>;
  open(input: { keyId: string; sealed: string }): Promise<string>;
}
```

- **dev / self-host** — AES-GCM via Web Crypto, key from env. Fail closed if unset. The rule is
  already written down at [platform-call.ts:40](../../packages/kernel/src/platform-call.ts):
  *"An unset secret is a failure, not a bypass."* Note the router secret currently does the
  opposite ([routed-node.ts:65](../../packages/kernel/src/routed-node.ts), `expectedSecret &&`)
  and Better Auth ships a hardcoded fallback
  ([staff-auth.ts:32](../../apps/control-plane/src/staff-auth.ts)); neither is a precedent to
  copy here.
- **hosted** — Cloudflare Secrets Store binding, or an external KMS behind the same interface.

Plaintext credentials must never be written to the directory, and **never** returned by any
`HostAdmin` read. Only the connector runtime gets an opened handle, for the duration of one
call.

### 3.4 The audit log will leak credentials unless we stop it

Two concrete hazards, both load-bearing:

1. **`_substrat_admin_log.before`/`after` are arbitrary JSON**
   ([control-plane-do.ts:309](../../packages/adapter-cloudflare/src/control-plane-do.ts)) and
   `recordAdmin` writes the admin payload
   ([host.ts:1242](../../packages/adapter-cloudflare/src/host.ts)). A naive
   `createConnection(actor, {…, refreshToken})` puts an OAuth refresh token into an
   **append-only** log in cleartext. Connection mutations must log metadata only — provider,
   label, scopes, actor — and never the secret, by construction rather than by care.
2. **`adminAction` is a closed enum**
   ([contracts/control-plane.ts:19-48](../../packages/contracts/src/control-plane.ts)) and
   `auditLog` parses **every row** through it
   ([host.ts:1212](../../packages/adapter-cloudflare/src/host.ts)). An unrecognised action does
   not degrade — it fails the read of the whole log. New members are mandatory, not optional.

### 3.5 The actor problem — the real fork

Every `HostAdmin` method takes a `PlatformActorId`. For connections that is wrong in exactly
the way D-31 already diagnosed for membership:

> a tenant admin is a `PrincipalId` and cannot act as itself, so routing those methods would
> launder every self-serve membership change through a platform actor

Connecting a Scrive account is a **tenant admin's** act, not platform staff's. Three options:

| | Shape | Cost |
|---|---|---|
| **A** | `HostAdmin` only, `PlatformActorId` | ships fastest; inherits the known defect; no self-service, ever, without redoing it |
| **B** | In-scope capability, like D-31 proposes for membership — module asks, executor effects | consistent with where membership is going; needs the same kernel seam membership needs |
| **C** | A third actor brand (`TenantAdminActorId`) | solves it narrowly; adds a third actor concept before anyone asked for one |

**Recommendation: A now, structured so B is not a rewrite.** Keep the store, the sealing and
the audit shape identical; let *who may call it* be the one thing that changes. Concretely:
land `HostAdmin.createConnection(actor: PlatformActorId, …)` first, and do not build a console
flow on top of it until the actor question is settled with membership's — because a console
flow is what would freeze the wrong answer.

This is a deliberate deferral of the same question, not an answer to it. Flagging it here so it
is reviewed rather than discovered.

### 3.6 Token refresh

Scrive is OAuth2: 1-hour access token, 30-day refresh. So refresh is not optional and it is not
request-time-only — a connection that idles past 30 days is dead and the tenant must be told
before a signature request fails.

Refresh needs the **same driver** §2.1 introduces. That is an argument for building the driver
once, properly, rather than a Scrive-specific timer.

### 3.7 Health

`last_ok_at` / `last_error` / `last_error_at` on the connection, written by the runtime. This
is where a dead-lettered delivery (§2.2) surfaces. Master plan §6 lists "per-tenant config +
health" as part of the framework; this is the minimum that makes §2.2's trade honest.

---

## 4. Connectors — the interface

### 4.1 What an executor is missing

The one real executor in the repo
([demos/rally/src/seed.ts:277](../../demos/rally/src/seed.ts)) needs only `admin`. A connector
needs two things the signature does not carry:

```ts
export type ExecutorHandler = (admin: HostAdmin, event: DomainEvent) => void | Promise<void>;
```

— no per-tenant connection, and no sanctioned egress. Proposed:

```ts
export interface ConnectorContext {
  readonly admin: HostAdmin;
  /** The tenant's live connection for this provider, refreshed; throws if absent/expired. */
  connection(provider: string): Promise<OpenConnection>;
  /** Sanctioned egress: policy, timeout, and per-connection health recording. */
  fetch(input: RequestInfo, init?: RequestInit): Promise<Response>;
}
export type ConnectorHandler = (ctx: ConnectorContext, event: DomainEvent) => Promise<void>;
```

`registerExecutor` stays for directory-effecting handlers (membership); `registerConnector`
takes the above. Both ride the same hardened dispatch.

Giving the connector its `fetch` rather than letting it import one is what makes egress policy,
timeouts and health recording enforceable instead of advisory — the same move `ctx.sql` makes
for module code.

### 4.2 Where it runs

Coordinator/host code, not the ScopeDO — already the stated intent
([scope-do.ts:391](../../packages/adapter-cloudflare/src/scope-do.ts): *"Executors run on the
COORDINATOR, not here"*). Module code remains unable to `fetch` at all.

---

## 5. Ingress — the return path

Tracked as [#96](https://github.com/substrat-run/substrat/issues/96) (transport) and
[#97](https://github.com/substrat-run/substrat/issues/97) (authority). Two findings from the
Scrive API that shape both:

**Scrive callbacks are unauthenticated.** The documented callback POSTs `document_id`,
`document_json` and `document_signed_and_sealed` to whatever `api_callback_url` you set, with
**no signature to verify** (retry: 5-minute delay, 10 attempts). So #96 cannot be built around
HMAC verification. The available design is:

- a **capability URL** — an unguessable secret in the callback path, since we choose the URL —
  and
- **never trust the body**: treat the callback as a hint, re-fetch document state from Scrive,
  and only then write.

That second rule is worth generalising: a webhook is a *cache invalidation*, not a fact.

**There is a polling endpoint** — `GET /api/v2/documents/{document_id}/get` returns the full
document with its status. So **#96 is optional for v1**: poll on the §2.1 driver, add webhooks
when latency justifies them. That removes the piece with the most security surface from the
critical path.

`surfaceName` is an open string ([contracts/routing.ts:24](../../packages/contracts/src/routing.ts)),
so a callback surface needs no contract change. The auth pattern to copy is
`/internal/provision`'s platform-secret gate
([demos/callout/src/worker.ts:224](../../demos/callout/src/worker.ts)) — deliberately *not*
under `/api/*`, which is the tenant-facing surface.

---

## 6. The Scrive connector, concretely

```
vertical                     hub (kernel)                  Scrive
────────                     ────────────                  ──────
requestSignatures(…)
  freezes content
  ctx.emit('protocol.
    signatures-requested') ──▶ connector, on the outbox
                               connection('scrive')
                               POST /api/v2/documents/new ──▶
                               POST …/{id}/setfile        ──▶
                               POST …/{id}/start          ──▶
                                                              (days)
                               poll …/{id}/get            ◀──  status: closed
                               invoke recordSignature(…)
                                 ← blocked on #97
```

Mapping: one `protocol_signature_requests` row per Scrive **party**;
`authentication_method_to_sign: "se_bankid"`; the Scrive document id lands in the request's
`external_ref`; the sealed PDF and history become `evidence_ref`.

**The dependency this exposes: Scrive signs a PDF, and we have none.** There is no PDF
capability anywhere in the repo, [master-plan.md §6](../master-plan.md) puts generation on the
build list against a documents engine that does not exist, and
[engine-protocol.md §7](engine-protocol.md) lists PDF rendering as an explicit non-goal.

### 6.1 The PDF question, answered

Investigated. Three findings:

1. **Scrive has no HTML/text → PDF endpoint.** It takes an uploaded file, or a template that
   already exists in Scrive.
2. **The template path is real**: `POST /api/v2/documents/newfromtemplate/{template_id}`
   uploads nothing. But per-document values must be threaded as **signatory fields**, so an
   avtal's salary and start date get modelled as attributes of a person rather than of the
   document — and the template itself then lives in Scrive's UI, outside version control and
   outside the protocol engine's immutable-template guarantee.
3. **Generating it ourselves is far smaller than "the documents engine".** PDF is a text
   format; a single page of text needs no library and no font embedding, because Helvetica is
   one of the base-14 fonts every reader ships. A working prototype — valid PDF 1.4, correct
   Swedish text — is **34 lines and 1.1 KB of output**, using only Web-standard APIs, so it
   runs unchanged in Workers.

**Recommendation: generate it, in the connector, for v0.** The decisive argument is not size,
it is consistency: the bytes we send to Scrive are derived from the same rows the content hash
covers, so the artifact and the attestation cannot drift. With a Scrive-side template they are
two independent renderings of the same intent, and nothing checks that they agree.

Keep the documents engine (master plan §6) for when a customer wants branded, laid-out output.
A Scrive-side template remains available per-customer without any code change.

::: danger The sharp edge, found by rendering rather than parsing
The first prototype produced a PDF that `file(1)` accepted, that parsed cleanly, and whose
em-dash rendered as **`€24`** and ellipsis as **`€46`**. Anything outside the character map
fell through and was silently mangled.

PDF text encoding is WinAnsi (CP1252), which differs from Latin-1 exactly in `0x80`–`0x9F`,
which is exactly where typographic punctuation lives. So the failure mode is silent
substitution in a legal document — and it is invisible to every check short of looking at the
rendered page.

The mitigation is to **throw on any character that cannot be encoded**, never approximate. A
contract that fails to render is recoverable; one that renders wrongly and gets signed is not.
:::

---

## 7. Non-goals (v0)

Webhook ingress (poll first, §5). A general connector marketplace or per-tenant connector
enablement UI. OAuth **authorization-code** flows in the console — v0 accepts credentials
administratively. Rate-limit orchestration across tenants. Replacing the module consumer path,
which is unchanged throughout.

---

## 8. Tracking

- [#100](https://github.com/substrat-run/substrat/issues/100) — executor runtime (§2), the prerequisite
- [#101](https://github.com/substrat-run/substrat/issues/101) — connection store (§3)
- [#96](https://github.com/substrat-run/substrat/issues/96) — webhook ingress (§5), deferrable via polling
- [#97](https://github.com/substrat-run/substrat/issues/97) — inbound authority seam (§5)

---

## 9. Review questions for the human

1. **§2.2** — is a failed executor delivery genuinely invisible to the caller? It is the right
   answer for an outbox and it does mean an operation can report success while its external
   effect has not happened.
2. **§3.5** — accept option A (platform actor now, structured so B is cheap), or settle the
   actor question here together with membership's rather than deferring it twice?
3. **§2.1** — is a ScopeDO `alarm()` the right driver, given nothing uses alarms yet and it
   would become the first scheduled work in the system?
4. **§4.1** — `registerConnector` as a second registration alongside `registerExecutor`, or
   widen `ExecutorHandler` in place? The latter is fewer concepts and a breaking change to a
   surface with exactly one caller.
5. **§6** — how much PDF is acceptable in v0: a minimal generated avtal, a Scrive-side template,
   or is this the trigger for the documents engine master plan §6 describes?
6. Sequencing sanity check: **§2 before §3** — the runtime before the store — because a
   connection store whose consumer cannot retry is a store nobody can use safely.
