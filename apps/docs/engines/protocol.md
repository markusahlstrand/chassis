# Protocol engine

`@substrat-run/engine-protocol` — **protocols and checklists with the sign → immutable
invariant**: egenkontroller, installation protocols, service checklists, per-item
condition reports. A protocol is the compliance artifact a field-service or workshop
business must be able to produce, unaltered, years later.

The engine owns only the invariants. Template **content** — which protocols exist, what
sections and items they contain, which are mandatory when — is 100% vertical-owned. An
instance binds to any `EntityRef` (a work order today, a bike or an apartment tomorrow);
the engine never knows the vertical's vocabulary.

## Templates, instances, responses, signatures

Four concepts, mirrored by four tables (migration `0001-init`, inside each scope's own
database):

- **`protocol_templates`** — `key`, `version`, `title`, and `content_json` (sections →
  items). Immutable per `(key, version)`: new content is a **new version**, never an
  edit. Item types are `check` (boolean), `value` (a measurement — decimal string, with
  an optional `unit` like `MΩ`), and `text`.
- **`protocol_instances`** — a template pinned at `(key, version)` bound to an
  `entity_type`/`entity_id`, with `status` `open` → `signed` → (or) `voided`.
- **`protocol_responses`** — append-only fill entries: `item_key`, `value_json`, `note`,
  `responded_by`, `responded_at`. **Latest-per-item wins**, ordered by append (`rowid`,
  same-millisecond safe) — the history *is* audit material ("value changed from 4.2 to
  5.1 before signing").
- **`protocol_signatures`** — `signed_by`, `kind` (`primary`/`counter`), `method`,
  `content_hash`, optional `evidence_ref`. Exactly one `primary` per signed instance.

The template pins at instantiation forever: editing a template tomorrow never rewrites
what a signed document referred to.

## The invariants

1. **Sign freezes.** Once an instance is `signed`, any write to its responses fails at
   the engine. Filling is only possible on an `open` instance.
2. **Verifiable content hash.** At sign time the engine computes a SHA-256 over the
   template content plus the latest response per item. The recipe is the contract —
   anyone can replay it against the stored rows and compare:

   ```
   '<key>@<version>\n<content_json>\n' + 'item=value_json\n' per item, items sorted by key
   ```

   The hash is Web Crypto (`globalThis.crypto`), so the same code runs in Node,
   Workers, and the browser.
3. **Counter-signature on frozen content.** A counter-signature (the customer at pickup)
   is a *second signature row* on the **same** frozen content — the engine recomputes
   the hash and it must equal the primary's, so a counter-sign can never silently attach
   to changed content. A principal never counter-signs what they primary-signed, and
   never counter-signs twice.
4. **Append-only responses**, bound to an open instance (above).
5. **Every mutation emits a fat event** (below) — a consumer never needs a cross-module
   read.
6. **Void, not delete.** A superseded protocol is `voided` (with a reason and an event),
   never mutated or removed; a replacement is a new instance.

## The signature model: provider-agnostic evidence

A signature records `signed_by` + `method` + `content_hash` + optional `evidence_ref`.
The v0 method is **`in-app`**: the authenticated principal taps sign, and integrity
comes from the engine itself — the hash, the immutability, the spine event. No third
party, works self-hosted.

Stronger methods (**`bankid`**, **`scrive`**, …) arrive later through the *same* sign
operation: a connector runs the external flow and calls sign with upgraded evidence (a
sealed PDF, a transaction id, a provider audit log) in `evidence_ref`. eIDAS
advanced/qualified levels are an evidence-quality upgrade, not a different engine path —
the engine never imports a vendor SDK.

## Sign is separate from fill

`protocol:fill` and `protocol:sign` are deliberately distinct permissions. The
field reality: the technician fills the protocol, but only the *arbetsledare* signs it.
Filling records the responder as `ctx.principal`; signing records the signer. Attribution
comes from the ambient context, never from the input.

## The completion guard

The engine exports a plain in-scope predicate for "obligatorisk för status" — a work
order can't complete until its protocol is signed:

```ts
import { requireSigned } from '@substrat-run/engine-protocol';

host.defineOperation('acme/workorder-complete', async (ctx, input) => {
  assertAllowed(await ctx.check(WORKORDER_PERM.complete));
  requireSigned(ctx, input.order, 'egenkontroll-el'); // throws if not signed
  return completeWorkOrder(ctx, input);
});
```

This is the vertical-composed form of the guard: the work-order engine knows nothing of
protocols, the protocol engine checks its own tables, and the *vertical* wires the two —
star topology intact. A manifest-declared form (so dropping a compliance gate shows up
in the reviewable diff) is the planned evolution; see
[open question 11](https://github.com/substrat-run/substrat/blob/main/docs/design/engine-protocol.md).
Until then, the `requireSigned` call site **is** the compliance gate.

## Operations, permissions, events

| Operation | Permission | Does |
|---|---|---|
| `protocol/define-template` | `protocol:create` | register a new template version |
| `protocol/instantiate` | `protocol:create` | start an instance on an entity |
| `protocol/fill` | `protocol:fill` | append a response (open instances only) |
| `protocol/sign` | `protocol:sign` | freeze the instance forever |
| `protocol/countersign` | `protocol:countersign` | add a second signature on frozen content |
| `protocol/void` | `protocol:void` | supersede an instance (never deletes) |
| `protocol/get` · `list-for-entity` | `protocol:read` | read templates, instances, responses, signatures |

| Event | piiClass | Payload highlights |
|---|---|---|
| `protocol.instantiated` | none | instance id, template `(key, version)`, entity |
| `protocol.response-recorded` | none | instance id, response id, item key, value |
| `protocol.signed` | pseudonymous (`subjectId` = signer) | content hash + **frozen answers** |
| `protocol.countersigned` | pseudonymous (`subjectId` = counter-signer) | signer, counter-signer, hash, frozen answers |
| `protocol.voided` | none | instance id, reason |

The signature events carry the frozen answers in the payload — a *fat event*, so a
downstream consumer (an archival connector, a compliance export) never queries back.
Events referencing a person carry `piiClass: 'pseudonymous'` and the person's
`subjectId`, so a GDPR erasure crypto-shreds the person while the fact that a signed
protocol exists survives.

## Composing from a vertical

The registered operations are default bindings over exported in-scope functions —
`defineTemplate`, `instantiateProtocol`, `fillProtocol`, `signProtocol`,
`countersignProtocol`, `voidProtocol`, `getProtocol`, `listProtocolsForEntity`,
`requireSigned`. Your own operations call them in the same transaction, and you own the
permission check:

```ts
import { instantiateProtocol, PROTOCOL_PERM } from '@substrat-run/engine-protocol';

host.defineOperation('cykel/start-condition-report', async (ctx, input) => {
  assertAllowed(await ctx.check(PROTOCOL_PERM.create));
  return instantiateProtocol(ctx, {
    templateKey: 'condition-report',
    entity: input.bike, // any EntityRef — the vertical owns the vocabulary
  });
});
```

The vertical declares the `protocol → <parent>` entity relation in *its* manifest (the
engine can't know whether protocols hang off work orders, bikes, or apartments), and
supplies the template content.

## What this engine will not do

- **Template content** — sections, items, vocabulary, branschprotokoll packs are the
  vertical's. The engine validates fills against the pinned template shape; it authors no
  templates.
- **Branching/conditional templates, scheduled instantiation, PDF rendering, a photo
  pipeline, offline sync, a template marketplace** — explicit v0 non-goals.
- **External signature providers** — BankID/Scrive-class flows are connectors that call
  the same sign operation with upgraded evidence; the engine imports no vendor SDK.
