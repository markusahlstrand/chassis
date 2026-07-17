# Invoicing engine

`@substrat-run/engine-invoicing` — accumulates **invoice bases** (Swedish: *fakturaunderlag*)
from billable events and makes them **immutable once exported**. It is the reference
example of star-topology composition *and* cross-domain reuse: it builds invoice bases
from events in more than one domain — work-order completions and retail orders — with
zero imports from either producer.

## What it is — and isn't

This engine produces the *basis* for an invoice: per-customer collections of billable
lines with frozen prices and provenance, ready to hand to whatever actually issues
invoices (typically an accounting connector — Fortnox/Visma-class). It is **not** a
ledger, not accounts receivable, not payment tracking — that territory belongs to
accounting systems, reached through connectors.

## How lines arrive: snapshot, not join

The engine declares its consumptions in its manifest — **additively**, one domain at a time:

```ts
events: {
  consumes: [
    { type: 'workorder.completed', schemaVersion: 1 },  // the original producer
    { type: 'commerce.order-placed', schemaVersion: 1 }, // added for the shop vertical
  ],
}
```

Each event has its **own** consumer with its **own** Zod view of the payload. Adding the
second was a pure additive change (D-28): a new `consumes` entry, a new parser, a new
handler — no migration, no permission, the `workorder.completed` path untouched. That is
engine reuse across verticals, demonstrated — the same immutability and snapshot machinery
serves a field-service firm and a coffee roaster.

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

The `commerce.order-placed` consumer is the same four steps with its own payload parse and
`source_type: 'order'` (a discount arrives as a negative line, so the underlag total stays
net) — snapshot-not-join is domain-agnostic.

Consumers are delivered **at-least-once** and run under a system actor. Three things keep
the handlers idempotent: find-or-create, the kernel's delivery journal, and a **source-id
guard** — before inserting anything, each consumer asks whether lines for that
`source_id` already exist and returns if they do. The source order is the dedup key, so a
replayed completion adds nothing rather than billing the customer twice.

Dispatch is **post-commit**, and each consumer runs in **its own transaction**. A consumer
that throws therefore does not roll back the producer — it rolls back only its own work and
the delivery is **dead-lettered** (journalled with the error) so one poison event cannot
wedge the loop. That is why a malformed payload leaves no half-built underlag, and why
`await` on the producing operation tells you nothing about whether the consumer succeeded.

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
(`addMoney`), never floats — and `addMoney`, not `addDecimal`, precisely because it is
**currency-aware**. Summing 100 SEK and 100 EUR into `200` is not a rounding error; it is a
financial artifact stating a number that means nothing, so the engine refuses instead.

**An underlag is one document in one currency.** A delivery whose lines disagree with each
other, or with the lines already on the open underlag, is rejected at write time and
dead-lettered — so a mixed-currency event never creates a document that can't be read or
exported. Currency is carried per line today; hoisting it onto the underlag itself is a
schema change and therefore a migration review.

## Operations, permissions, events

| Operation | Permission | Does |
|---|---|---|
| `invoicing/list` | `invoicing:read` | list underlag (optionally by status), each with its computed total |
| `invoicing/get` | `invoicing:read` | one underlag with all lines and total |
| `invoicing/export` | `invoicing:export` | flip to `exported` — the point of no return |

| Event | Version | Payload |
|---|---|---|
| `invoicing.underlag-updated` | 1 | `{ underlagId, addedLines, source: EntityRef }` |
| `invoicing.underlag-exported` | **2** | `{ underlagId, number, total: Money }` |

`invoicing.underlag-exported` is the natural hook for the next step in a vertical: an
accounting connector that turns the frozen basis into a real invoice.

::: warning underlag-exported is at schemaVersion 2
v1 carried `total` as a bare amount string with no currency — an amount that isn't an
amount, on the one event an accounting connector consumes. v2 makes it `Money`.

It is a **replace, not a dual-emit**, which is a deliberate exception to the usual
deprecation-window rule. Consumer dispatch keys on event **type** alone — the
`schemaVersion` in a manifest's `consumes` is not used for routing — so emitting v1 and v2
together would deliver *both* to every consumer of the type, and a connector could invoice
twice. A replace fails loudly instead: a v1 consumer's strict parse rejects v2 and
dead-letters, which is visible. If you consume this event, read `total.amount` and
`total.currency` rather than the old string.
:::

## Why this engine is a good template

If you're designing a new engine, this one shows the pattern at minimum size:

- **consumes a contract, not a sibling** — own payload parse, zero producer imports;
- **owns exactly one invariant worth owning** — exported means immutable;
- **stops at the domain boundary** — basis, not bookkeeping; the rest is connectors;
- **stays priceable** — `entitlementKey: 'invoicing'` gates it per tenant, independent
  of any other engine.
