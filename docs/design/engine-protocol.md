# Protocol engine — concept spec (pre-extraction draft)

Status: draft v0.1 · Last updated: 2026-07-14 · For review before any code

> **Relationship to canon.** Master plan §5/§6 and the decision log rule; this document
> proposes, it doesn't decide. It exists to be reviewed against decisions 26 (engine
> extension model), 27 (placement spectrum, extraction discipline) and to set up the
> resolution of kernel-design **open question 11** (cross-engine transition guards),
> which is explicitly "decide when the protocol engine lands."

## 1. What this is

Protocols/checklists with the sign → immutable invariant: egenkontroller, installation
protocols, service checklists — the FSM vendor's core compliance artifact (demo concept
§4). A protocol **template** defines sections and items (checkboxes, values,
measurements, free text, photo refs); an **instance** binds a template to an entity
(`workorder`, later anything); technicians **fill** it; a **signature** freezes it
forever. Content — which templates exist, what they contain, branschprotokoll packs —
is 100% vertical-owned. The engine owns only the invariants.

## 2. Placement (decision 27) and the extraction discipline

Placement tests, applied:

- **Guarantee-surface coupling**: signed-immutability, append-only fill history, and
  the audit trail are compliance-grade guarantees a vertical must inherit, not
  reimplement — too much guarantee surface for a template.
- **Reshaping need**: every vertical reshapes content (templates, vocabulary, which
  protocols are mandatory when) — too much reshaping for an integration.

Middle of the spectrum → engine form is right, **but decision 27 forbids designing it
ahead**: engines are extracted at the second vertical. So the build order is the
discipline, rehearsed at demo scale:

1. **Milestone A — Callout vertical code.** Protocol tables, fill flow, in-app sign,
   immutability enforcement live in `demos/callout/src` as vertical operations. No new
   package. The FSM demo gains its egenkontroll beat.
2. **Milestone B — the second shape forces extraction.** Handlebar needs a service
   checklist with a different shape (per-bike condition report; customer counter-sign
   at pickup). Extract `engines/protocol`: invariants move to the engine, both
   verticals' templates stay behind as content. The extraction diff is the proof the
   plan's least-proven hypothesis wants (§3), at rehearsal scale.
3. **Milestone C — the guard.** With two verticals gating transitions on signatures,
   decide open question 11 on real material (§6 below). *Built: both poles exist and
   each carries the case it fits; the decision-log entry for OQ11 awaits ratification.*

Each milestone is agent-loop material (runs 003–005): A extends a vertical, B is an
*extraction* — a benchmark shape no run has tested — and C is a kernel change behind
a manifest surface.

## 3. Domain model (engine-owned after extraction)

```
protocol_templates   id, key, version, title, content_json (sections/items), created_at
                     — immutable per (key, version); new content = new version
protocol_instances   id, template_key, template_version, entity_type, entity_id,
                     status ('open' | 'signed' | 'voided'), created_by, created_at
protocol_responses   id, instance_id, item_key, value_json, note, responded_by,
                     responded_at            — append-only; latest-per-item wins
protocol_signatures  id, instance_id, signed_by, method, content_hash,
                     evidence_ref, signed_at — exactly one per signed instance
```

Design choices to challenge in review:

- **Responses are append-only** (edit = new row). The fill history is itself audit
  material ("value changed from 4.2 to 5.1 before signing"), and it makes offline
  capture (master plan open question) event-shaped by construction.
- **Templates version immutably**; an instance pins (key, version) at instantiation.
  Editing a template never rewrites what a signed document referred to.
- **Voiding, not deleting**: a signed protocol can be superseded (`voided` + reason +
  event + replacement instance), never mutated or removed.

## 4. Invariants (what the engine *is*)

1. Sign freezes: any write to a signed instance's responses fails at the engine.
2. `content_hash` = hash over template content + latest responses at sign time; the
   signature row is verifiable against replayed state.
3. One signature per instance; counter-signatures (customer at pickup) are additional
   signature rows on the same frozen content, never new content.
4. Append-only responses, bound to an open instance.
5. Every mutation emits: `protocol.instantiated | response-recorded | signed |
   countersigned | voided` (fat payloads; a consumer never needs a cross-module read).
6. Every operation checks a permission: `protocol:create | fill | sign | countersign |
   read | void` — `sign` deliberately separate from `fill` (the FSM reality: the
   technician fills, sometimes only arbetsledare signs).

## 5. Signature model: provider-agnostic evidence

A signature records `signed_by` + `method` + `content_hash` + optional `evidence_ref`
(attachment). Methods:

- **`in-app`** (v0, always available): the authenticated principal taps sign. Integrity
  comes from the engine (hash, immutability, spine event) — the everyday field case,
  no third party, works self-hosted/escrow.
- **`bankid` / `scrive` / …** (connector slot, later): a connector in the integrations
  hub runs the external flow and calls the same sign operation with upgraded evidence
  (sealed PDF, transaction id, provider audit log) attached. eIDAS advanced/qualified
  levels are an evidence-quality upgrade, not a different engine path. The engine never
  imports a vendor SDK. Demo treatment: stubbed like Fortnox export.

## 6. The guard (open question 11) — both poles, built

"Obligatorisk för status": completing a work order requires protocol X signed. The two
poles from kernel-design, **both now implemented**, each carrying the case it fits.

### Pole 1 — vertical-composed (milestone A, shipped)

The vertical's `complete` operation calls the protocol engine's in-scope predicate
(`requireSigned(ctx, entityRef, templateKey)`) before the engine's `completeWorkOrder`.
Same pattern as the pricing moment; zero kernel machinery. Weakness (named in the open
question): it's glue an edit can silently drop — invisible to review, weak for
compliance.

**It is still the right pole when the policy is CONDITIONAL on vertical data.**
Callout owes an egenkontroll only on `montage` orders (`demos/callout/src/module.ts`):
`order.kind` is Callout vocabulary, and the kernel must never learn it. That guard
stays glue, on purpose.

### Pole 2 — manifest-declared (milestone C, shipped)

A module's **manifest** declares an unconditional pre-condition on an operation; another
module **contributes** the named predicate. Handlebar (`demos/handlebar`):

```ts
// manifest (the vertical — the layer that owns "what is mandatory when")
guards: [{
  before: 'bike-shop/close-repair',        // any registered OPERATION
  predicate: 'protocol/all-signed',        // a named predicate some module contributes
  config: {                                // opaque to the kernel; the predicate parses it
    templateKey: 'tillstandsrapport',
    entityType: 'workorder',
    entityIdFrom: 'orderId',               // which input field carries the entity id
    countersigned: true,                   // the customer accepted it at pickup
  },
}]

// registration (the engine — contributes the code half, wires nothing)
export const protocolModule: ModuleRegistration = {
  manifest: protocolManifest,
  predicates: { 'protocol/all-signed': allSignedPredicate },
  operations: { … },
};

// kernel contract
export type GuardPredicate = (
  ctx: OperationContext,
  config: Record<string, unknown>,
  input: unknown,
) => void | Promise<void>;        // throws → BLOCK; returns → allow
```

**Where it fires:** inside the scope actor task and inside the operation's own
`BEGIN IMMEDIATE … COMMIT`, immediately *before* the handler. A throw rolls the
transaction back exactly like a handler throw — no row, no event, fail closed.

**Resolution is late, and that is deliberate.** Registration order is caller-controlled
(a vertical may register before the engine whose predicate it wires), so a fast-fail at
`registerModule` would reject wiring that is merely *early*. Predicates therefore resolve
at invoke; an unresolvable name **blocks** the guarded operation ("unknown guard
predicate"). A typo can never widen a gate, only close one. What *is* enforced eagerly is
the half the kernel can see whole: predicate names are global and may not collide.

Star topology holds: the workorder engine knows nothing of protocols; the protocol engine
knows nothing of bike shops; the vertical manifest wires them. Because the gate is
manifest surface, adding or **dropping** it lands in the reviewable diff — the property
vertical-composed glue lacks.

### The rule, stated once

> Manifest guards are **unconditional gates on an operation**. Policy conditional on
> vertical data stays **vertical-composed glue** inside the operation.

### Pole 2's complement — operation withdrawal (what makes the guard *enforceable*)

A guard binds the **operation it names**. On its own that makes a gate *reviewable* but
not *enforceable*: Handlebar gates `bike-shop/close-repair`, while the engine's own
`workorder/close` would stay registered — and any caller holding `workorder:close` could
walk around the gate. (Confirmed in the demo before this landed: sign without
counter-signing, `bike-shop/close-repair` blocks, plain `workorder/close` closes it
anyway.) Gating `workorder/close` directly is not the answer: it would make the gate
unconditional for *every* repair, and a punktering carries no condition report.

The fix is the missing half of the surface — a manifest may **withdraw** another module's
default binding:

```ts
// bike-shop manifest
withdraws: ['workorder/close'],   // the name stops resolving in THIS host
```

- **Withdrawal removes the BINDING, not the capability.** The engine's in-scope
  `closeWorkOrder(ctx, …)` stays exported and composable — it is exactly what the
  vertical's guarded `bike-shop/close-repair` calls. The engine loses a default door, not
  a function.
- **Order-independent.** A vertical may register before or after the engine it withdraws
  from; the host keeps a `withdrawn` set, `defineOperation` skips a withdrawn name, and a
  manifest that withdraws an already-registered operation removes it from the map.
- **Fails closed and looks like nothing special.** A withdrawn operation is
  indistinguishable from one that was never registered: `unknown operation`.
- **Opt-in, never self-inflicted.** Callout withdraws nothing and keeps
  `workorder/close`. A module withdrawing its *own* operation throws — it is meaningless
  and would hide bugs.

Guard + withdrawal together: **the only door to `closed` in Handlebar is the vertical's
pickup ceremony, and the kernel refuses it until the customer has counter-signed.** The
gate is now in the manifest diff *and* in the execution path.

## 7. Explicit non-goals (v0)

Conditional/branching templates, scheduled/recurring instantiation, PDF rendering,
photo capture pipeline (attachment contract covers storage), offline sync (binds to the
master-plan offline question, not solved here), template marketplace.

## 8. Review questions for the human

1. ~~Rehearsal (A/B) vs direct engine build?~~ **Resolved 2026-07-14: rehearsal.**
   Milestone A ships as Callout vertical code; extraction happens at milestone B.
2. Is append-only responses right, or is latest-value-with-audit-log enough?
3. Counter-signature as second signature row on frozen content — does the bike-shop
   pickup flow actually need the customer to sign *after* content freezes, or before?
4. ~~Guard proposal: is `before:`-operation granularity right, or do guards belong on
   engine *transitions* (status values) rather than operations?~~ **Resolved 2026-07-14
   (milestone C): OPERATIONS.** Transitions were rejected on three counts. (a) *The
   kernel would have to learn engine internals*: a transition key like
   `workorder: in_progress → completed` only means something if the kernel knows that
   engine's status vocabulary and its state machine — exactly the domain knowledge the
   three-layer rule keeps out of layer 1. Operations are already the kernel's own
   vocabulary (it registers them, it invokes them, it wraps them in a transaction). (b)
   *There is no interception point*: a transition happens deep inside an engine's
   in-scope function, called from a vertical's handler inside an open transaction — the
   kernel never sees it, so enforcing there would mean a callback surface reaching into
   engine code (the star topology's collapse). The operation boundary is the only place
   the kernel legitimately stands between a caller and domain code. (c) *Transitions are
   the wrong unit of review*: what compliance cares about is "closing a repair requires
   the customer's counter-signature", a business moment the vertical names. It is an
   operation. The cost of the choice — a guard binds one operation, so the engine's
   default binding for the same transition was an unguarded path — is paid by
   withdrawal (§6), not by more guard machinery.
5. ~~Should a vertical be able to withdraw / re-bind an engine's default operations (so
   `workorder/close` cannot bypass `bike-shop/close-repair`)?~~ **Resolved 2026-07-14:
   yes — `withdraws: string[]` on the manifest, order-independent, opt-in, binding-only.
   The bypass is closed; the demo asserts `workorder/close` is now `unknown operation`
   in Handlebar's host while Callout keeps it.**
