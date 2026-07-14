# @substrat-run/engine-workorder

Work-order engine for [Substrat](https://github.com/substrat-run/substrat) — one
engine covering **work orders, time reporting, and material reporting**. One state
machine, append-only reporting, and a billable snapshot frozen at completion.

It deliberately knows nothing about pricing (the vertical's job) or invoicing (a
sibling engine, reached only via events).

**Full documentation: https://substrat.ahlstrand.es/engines/workorder**

## Invariants the engine owns

- **The state machine cannot skip states.**
  `planned → in_progress → completed → closed`; invalid transitions throw. No caller
  can complete a planned order or restart a completed one.
- **Time and material are append-only.** There is no update or delete operation for
  reported entries; corrections are compensating entries, never silent edits.
- **Attribution comes from the ambient principal**, never from the input.
- **Every mutation emits a fat event** — `workorder.completed` carries the full
  billable snapshot, so downstream consumers never query back.

## The pricing boundary

The vertical prices, the engine freezes. `complete` takes priced billable lines —
each with provenance (`sourceType`, `sourceId`) back to the reported entry — validates
them with exact decimal arithmetic, sums the total, and freezes the snapshot into the
`workorder.completed` payload.

## Composing from a vertical

The registered operations (`workorder/create`, `assign`, `start`, `report-time`,
`report-material`, `complete`, `close`) are default bindings. For custom flows, call
the exported in-scope functions inside your own operations — same transaction, your
permission check:

```ts
import { createWorkOrder, PERM } from '@substrat-run/engine-workorder';

host.defineOperation('acme/ticket-to-order', async (ctx, input) => {
  assertAllowed(await ctx.check(PERM.create));
  return createWorkOrder(ctx, {
    facility: input.facility, // opaque EntityRef — the vertical owns facilities
    customer: input.customer,
    kind: 'felanmalan',
    title: input.title,
  });
});
```

Facilities, customers, and articles are opaque `EntityRef`s the vertical owns; the
engine records quantities, not prices.

## Related packages

- [`@substrat-run/kernel`](https://npmjs.com/package/@substrat-run/kernel) — the
  scope-host contract these operations run on
- [`@substrat-run/engine-invoicing`](https://npmjs.com/package/@substrat-run/engine-invoicing) —
  consumes `workorder.completed` into immutable invoice bases

## Status

Pre-release (0.x): surfaces change without notice until the first vertical ships.
