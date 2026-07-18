# Protocol engine

`@substrat-run/engine-protocol` — **protocols and checklists with the sign → immutable
invariant**: egenkontroller, installation protocols, service checklists, per-item condition
reports. A protocol is the compliance artifact a field-service or workshop business must be
able to produce, unaltered, years later.

The engine owns only the invariants. Template **content** — which protocols exist, what
sections and items they contain, which are mandatory when — is 100% vertical-owned. An
instance binds to any `EntityRef` — a work order, a bike's condition report, or an
employee's **onboarding checklist**, all three shipping in the demo verticals — and the
engine never knows the vertical's vocabulary. (The HR vertical even signs onboarding as the
*employee*, not a supervisor: same engine, the vertical's grant decides who signs.)

## At a glance

| | |
|---|---|
| **Package** | `@substrat-run/engine-protocol` |
| **Entitlement key** | `protocol` |
| **Owns** | version-pinned templates, append-only responses, sign→immutable, a verifiable content hash |
| **Emits** | 5 events, `protocol.instantiated` → `protocol.voided` ([events](./events)) |
| **Consumes** | nothing |
| **Permissions** | 6 (`protocol:create` · `fill` · `sign` · `countersign` · `read` · `void`) |
| **Contributes** | the `protocol/all-signed` guard predicate — the only config-shaped surface in any engine |
| **Status** | product seed (0.x) — the extraction proof |

## What it owns

1. **Sign freezes.** Once signed, any write to an instance's responses fails.
2. **Verifiable content hash.** SHA-256 over template content + latest responses at sign
   time — replayable against stored rows by anyone.
3. **Counter-signature on frozen content.** A second signature whose hash must equal the
   primary's, so it can never silently attach to changed content.
4. **Append-only responses.** An edit is a new row; the history *is* audit material.
5. **Version-pinned templates.** An instance pins `(key, version)` at instantiation forever.
6. **Void, not delete.** A superseded protocol is voided with a reason, never removed.

Details: [Domain model & invariants](./model).

## What it will not do

- **Template content** — sections, items, vocabulary, branschprotokoll packs are the
  vertical's. The engine validates fills against the pinned template shape; it authors no
  templates.
- **External signature providers** — BankID/Scrive-class flows are connectors that call the
  same sign operation with upgraded evidence; the engine imports no vendor SDK.
- **Branching/conditional templates, scheduled instantiation, PDF rendering, a photo
  pipeline, offline sync, a template marketplace** — explicit v0 non-goals.

## Is this a good match?

| Reach for it when | Look elsewhere when |
|---|---|
| Someone must **attest** to a set of answers, and that attestation must hold up later | You just need a form; a table and a timestamp are cheaper |
| "Prove this wasn't altered after signing" is a real question | Nobody will audit it |
| The person who fills is not always the person who signs | One actor does everything |
| A second party (customer at pickup) confirms the same content | There's no counterparty |
| The checklist's *content* is yours and changes over time | You want the engine to ship the checklists — it won't |

The clarifying question: **is the signature load-bearing?** If the value is in the answers,
you want a form. If the value is in *who stood behind the answers, and that they haven't
changed since* — that's this engine.

This engine is the **extraction proof**: it was forced out of vertical code only when a
*second* vertical (a bike shop's per-bike condition report) needed the same sign-immutability
invariant in a different shape. Engines get extracted when a second consumer proves the line,
not when someone predicts one.
