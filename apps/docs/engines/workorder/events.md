# Events

The engine **emits 7 and consumes none** — it is a source, not a sink. Nothing upstream
drives a work order; the vertical does, through operations.

```ts
events: {
  emits: [ /* the 7 below */ ],
  consumes: [],
}
```

## Emitted

| Event | v | piiClass | Payload |
|---|---|---|---|
| `workorder.created` | 1 | none | order id, number, facility, customer, kind, title |
| `workorder.assigned` | 1 | pseudonymous | order id, technician |
| `workorder.started` | 1 | none | order id |
| `workorder.time-reported` | 1 | pseudonymous | order id, entry id, hours |
| `workorder.material-reported` | 1 | none | order id, line id, article, qty |
| `workorder.completed` | 1 | none | order id, number, facility, customer, **billable lines + total** |
| `workorder.closed` | 1 | none | order id |

## `workorder.completed` — the contract that matters

This is the engine's real public surface. It is a **fat event**: the full priced snapshot
travels in the payload, so a consumer never needs a cross-module read.

```ts
{
  orderId, number, facility: EntityRef, customer: EntityRef,
  billable: [{ article, description, qty, unit, unitPrice: Money, lineTotal: Money,
               sourceType: 'time' | 'material', sourceId }],
  total: Money,
}
```

The [invoicing engine](/engines/invoicing/) consumes this with **zero imports** from here,
parsing its own Zod view of the payload. That's star topology in one line: this engine has
never heard of invoicing, and invoicing has never heard of this package.

Because the payload is fat, prices are frozen at the moment of completion. If the vertical's
price list changes tomorrow, yesterday's invoice basis doesn't.

## PII and erasure

Events referencing a person carry `piiClass: 'pseudonymous'` and that person's `subjectId`
(`workorder.assigned` → the technician; `workorder.time-reported` → the reporter). A GDPR
erasure can then crypto-shred the person while the operational facts — hours were worked on
this order — survive.

## Evolution rules

Payload fields are **frozen once shipped**. New fields may be added; renaming, removing, or
retyping one means a `schemaVersion` bump.

Read the [invoicing engine's `underlag-exported` v2](/engines/invoicing/events#versioning)
before you bump anything — consumer dispatch keys on event **type alone**, so dual-emitting
two versions delivers *both* to every consumer of that type. That constraint applies to these
events too.
