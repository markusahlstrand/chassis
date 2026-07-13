# Invoicing engine

`@chassis/engine-invoicing` — accumulates **invoice bases** (Swedish: *fakturaunderlag*)
from billable events and makes them **immutable once exported**. It is the reference
example of star-topology composition: it consumes the work-order engine's events with
zero imports from it.

## What it is — and isn't

This engine produces the *basis* for an invoice: per-customer collections of billable
lines with frozen prices and provenance, ready to hand to whatever actually issues
invoices (typically an accounting connector — Fortnox/Visma-class). It is **not** a
ledger, not accounts receivable, not payment tracking — that territory belongs to
accounting systems, reached through connectors.

## How lines arrive: snapshot, not join

The engine declares one consumption in its manifest:

```ts
events: {
  consumes: [{ type: 'workorder.completed', schemaVersion: 1 }],
}
```

When a work order completes, the consumer:

1. **Parses its own view of the payload** — its own Zod schema of the event contract,
   never the producer's types:

   ```ts
   const completedPayload = z.object({
     orderId: z.string().min(1),
     customer: entityRef,
     billable: z.array(z.object({ article, description, qty, unit, unitPrice: money, lineTotal: money, sourceType, sourceId })),
     total: money,
   });
   ```

2. **Finds or creates the open underlag** for that customer — one open collection per
   customer at a time.
3. **Copies the billable lines** — article, description, qty, unit, unit price, line
   total — with provenance (`source_type: 'workorder'`, `source_id: orderId`).
4. **Emits `invoicing.underlag-updated`.**

Prices and quantities are **frozen from the event payload** at the moment the work
order completed. If the vertical's price list changes tomorrow, yesterday's underlag
doesn't — which is exactly what an invoice basis must guarantee. Provenance is kept as
`EntityRef` columns, so every line can answer "where did you come from?" without the
engine ever querying the work-order tables.

Consumers are delivered **at-least-once** and run under a system actor; the find-or-create
plus the kernel's delivery journal keep the handler idempotent.

## The immutability invariant

An underlag is `open` or `exported`:

- While **open**, consumed events append lines.
- **`invoicing/export`** flips it to `exported` — and from then on it is immutable.
  Nothing appends to it, nothing edits it, and attempting to export it again throws.
- Billable work arriving *after* export (a late time report, a re-opened order) opens a
  **new** underlag. History is never rewritten; late facts become new facts.

This is the engine invariant on top of the kernel's guarantees: the kernel makes events
trustworthy; the engine makes the financial artifact derived from them tamper-proof.

## Domain model

- **`invoicing_underlag`** — id, sequential `number`, customer as `EntityRef` columns,
  `status` (`open`/`exported`), `created_at`, `exported_at`.
- **`invoicing_lines`** — underlag, provenance (`source_type`, `source_id`), article,
  description, qty, unit, unit price (amount + currency), line total, `created_at`.

Totals are computed with the sanctioned [exact decimal arithmetic](/concepts/money)
(`addDecimal`), never floats.

## Operations, permissions, events

| Operation | Permission | Does |
|---|---|---|
| `invoicing/list` | `invoicing:read` | list underlag (optionally by status), each with its computed total |
| `invoicing/get` | `invoicing:read` | one underlag with all lines and total |
| `invoicing/export` | `invoicing:export` | flip to `exported` — the point of no return |

| Event | Payload highlights |
|---|---|
| `invoicing.underlag-updated` | underlag id, lines added, source ref |
| `invoicing.underlag-exported` | underlag id, number, final total |

`invoicing.underlag-exported` is the natural hook for the next step in a vertical: an
accounting connector that turns the frozen basis into a real invoice.

## Why this engine is a good template

If you're designing a new engine, this one shows the pattern at minimum size:

- **consumes a contract, not a sibling** — own payload parse, zero producer imports;
- **owns exactly one invariant worth owning** — exported means immutable;
- **stops at the domain boundary** — basis, not bookkeeping; the rest is connectors;
- **stays priceable** — `entitlementKey: 'invoicing'` gates it per tenant, independent
  of any other engine.
