# @substrat-run/engine-invoicing

Invoicing engine for [Substrat](https://github.com/substrat-run/substrat) —
accumulates **invoice bases** (Swedish: *fakturaunderlag*) from billable events and
makes them **immutable once exported**.

It produces the *basis* for an invoice: per-customer collections of billable lines
with frozen prices and provenance, ready to hand to whatever actually issues invoices
(typically an accounting connector). It is **not** a ledger, not accounts receivable,
not payment tracking.

**Full documentation: https://substrat.ahlstrand.es/engines/invoicing**

## Snapshot, not join

The engine consumes `workorder.completed` with **zero imports** from the work-order
engine — star topology. The consumer parses its own Zod view of the event payload,
finds or creates the open underlag for that customer, and copies the billable lines
with provenance (`source_type`, `source_id`):

```ts
events: {
  consumes: [{ type: 'workorder.completed', schemaVersion: 1 }],
}
```

Prices are frozen from the payload at the moment the work order completed. If the
vertical's price list changes tomorrow, yesterday's underlag doesn't. Consumers are
delivered at-least-once; find-or-create, the kernel's delivery journal, and a
**source-id guard** (the source order is the dedup key) keep each handler idempotent, so
a replay adds nothing rather than billing twice.

An underlag is **one document in one currency**: totals use the currency-aware `addMoney`,
and a delivery whose lines disagree on currency is rejected at write time and
dead-lettered rather than producing a total that means nothing.

## The immutability invariant

An underlag is `open` or `exported`:

- While **open**, consumed events append lines.
- **`invoicing/export`** flips it to `exported` — from then on it is immutable.
  Nothing appends, nothing edits, exporting again throws.
- Billable work arriving *after* export opens a **new** underlag. History is never
  rewritten; late facts become new facts.

`invoicing.underlag-exported` (**schemaVersion 2**) is the natural hook for an accounting
connector that turns the frozen basis into a real invoice. Its payload is
`{ underlagId, number, total: Money }`; v1's `total` was a bare string with no currency.
v2 **replaces** v1 rather than dual-emitting, because consumer dispatch keys on event type
alone — emitting both would deliver both to one consumer and risk a double invoice.

## Operations

| Operation | Permission | Does |
|---|---|---|
| `invoicing/list` | `invoicing:read` | list underlag, each with computed total |
| `invoicing/get` | `invoicing:read` | one underlag with all lines and total |
| `invoicing/export` | `invoicing:export` | flip to `exported` — the point of no return |

Totals use exact decimal arithmetic from
[`@substrat-run/contracts`](https://npmjs.com/package/@substrat-run/contracts), never floats.

## Related packages

- [`@substrat-run/kernel`](https://npmjs.com/package/@substrat-run/kernel) — the
  scope-host contract these operations run on
- [`@substrat-run/engine-workorder`](https://npmjs.com/package/@substrat-run/engine-workorder) —
  the producer of the billable events this engine consumes

## Status

Pre-release (0.x): surfaces change without notice until the first vertical ships.
