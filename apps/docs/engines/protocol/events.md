# Events

The engine **emits 5 and consumes none** — protocols are driven by operations, not by
upstream facts.

```ts
events: {
  emits: [ /* the 5 below */ ],
  consumes: [],
}
```

## Emitted

| Event | v | piiClass | Payload |
|---|---|---|---|
| `protocol.instantiated` | 1 | none | instance id, template `(key, version)`, entity |
| `protocol.response-recorded` | 1 | none | instance id, response id, item key, value |
| `protocol.signed` | 1 | pseudonymous | signer, content hash, **frozen answers** |
| `protocol.countersigned` | 1 | pseudonymous | signer, counter-signer, hash, **frozen answers** |
| `protocol.voided` | 1 | none | instance id, reason |

## The signature events carry the whole document

`protocol.signed` and `protocol.countersigned` are **fat events**: the frozen answers travel
in the payload alongside the content hash. A downstream consumer — an archival connector, a
compliance export — never queries back.

This matters more here than elsewhere. The point of the engine is that a signed protocol can
be produced *unaltered, years later*. An event carrying the hash but not the answers would
force the consumer to re-read tables that may have moved on, which is exactly the join the
snapshot discipline exists to prevent. The event **is** the archival record.

## PII and erasure

Events referencing a person carry `piiClass: 'pseudonymous'` and that person's `subjectId`.
A GDPR erasure crypto-shreds the person while the fact that a signed protocol exists survives.

That split is deliberate and slightly subtle: the *compliance* claim ("this protocol was
signed, and here is its hash") outlives the *personal* claim ("by this named individual").
The artifact stays verifiable; the person becomes unidentifiable.

## Evolution rules

Payload fields are **frozen once shipped**. New fields may be added; renaming, removing, or
retyping one means a `schemaVersion` bump.

Before bumping, read the
[invoicing engine's `underlag-exported` v2 note](/engines/invoicing/events#versioning):
consumer dispatch keys on event **type alone**, so dual-emitting two versions delivers *both*
to every consumer of that type. The "deprecation window" the conventions describe isn't
actually available until version routing exists.
