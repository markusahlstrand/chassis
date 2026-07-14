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

1. **Milestone A — ServiceCo vertical code.** Protocol tables, fill flow, in-app sign,
   immutability enforcement live in `demos/fsm/src` as vertical operations. No new
   package. The FSM demo gains its egenkontroll beat.
2. **Milestone B — the second shape forces extraction.** CykelService needs a service
   checklist with a different shape (per-bike condition report; customer counter-sign
   at pickup). Extract `engines/protocol`: invariants move to the engine, both
   verticals' templates stay behind as content. The extraction diff is the proof the
   plan's least-proven hypothesis wants (§3), at rehearsal scale.
3. **Milestone C — the guard.** With two verticals gating transitions on signatures,
   decide open question 11 on real material (§6 below).

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

## 6. The guard (open question 11) — proposed resolution shape

"Obligatorisk för status": completing a work order requires protocol X signed. The two
poles from kernel-design:

- *Vertical-composed* (milestone A): the vertical's `complete` operation calls the
  protocol module's in-scope predicate (`requireSigned(ctx, entityRef, templateKey)`)
  before the engine's `completeWorkOrder`. Same pattern as the pricing moment; zero new
  kernel machinery. Weakness (named in the open question): it's glue an AI edit can
  silently drop — invisible to review, weak for compliance.
- *Manifest-declared* (proposal for milestone C): the **vertical manifest** declares

  ```ts
  guards: [{
    before: 'workorder/complete',                 // any registered operation
    predicate: 'protocol/all-signed',             // an in-scope predicate the
    config: { templateKey: 'egenkontroll-el' },   // protocol module exports
  }]
  ```

  The kernel evaluates the predicate inside the same scope transaction before running
  the guarded operation. Star topology holds: the workorder engine knows nothing of
  protocols, the protocol module implements a predicate against its own tables, and the
  *vertical manifest* — the layer that owns "what's mandatory when" — wires them.
  Because it's manifest surface, a guard change lands in the reviewable diff: adding or
  **dropping** a compliance gate becomes human-checkpoint material, which is exactly
  the property vertical-composed glue lacks.

Milestone A ships the first pole; C decides whether the second is pinned (the manifest
change is additive, per the open question's own note).

## 7. Explicit non-goals (v0)

Conditional/branching templates, scheduled/recurring instantiation, PDF rendering,
photo capture pipeline (attachment contract covers storage), offline sync (binds to the
master-plan offline question, not solved here), template marketplace.

## 8. Review questions for the human

1. ~~Rehearsal (A/B) vs direct engine build?~~ **Resolved 2026-07-14: rehearsal.**
   Milestone A ships as ServiceCo vertical code; extraction happens at milestone B.
2. Is append-only responses right, or is latest-value-with-audit-log enough?
3. Counter-signature as second signature row on frozen content — does the bike-shop
   pickup flow actually need the customer to sign *after* content freezes, or before?
4. Guard proposal: is `before:`-operation granularity right, or do guards belong on
   engine *transitions* (status values) rather than operations?
