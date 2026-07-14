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
delivered at-least-once; find-or-create plus the kernel's delivery journal keep the
handler idempotent.

## The immutability invariant

An underlag is `open` or `exported`:

- While **open**, consumed events append lines.
- **`invoicing/export`** flips it to `exported` — from then on it is immutable.
  Nothing appends, nothing edits, exporting again throws.
- Billable work arriving *after* export opens a **new** underlag. History is never
  rewritten; late facts become new facts.

`invoicing.underlag-exported` is the natural hook for an accounting connector that
turns the frozen basis into a real invoice.

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
