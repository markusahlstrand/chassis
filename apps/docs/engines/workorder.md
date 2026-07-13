# Work-order engine

`@substrat-run/engine-workorder` — one engine covering **work orders, time reporting, and
material reporting**. One state machine, append-only reporting, and a billable snapshot
at completion. It deliberately knows nothing about pricing (the vertical's job) or
invoicing (a sibling engine, reached only via events).

## The state machine

```
planned ──assign──▶ planned ──start──▶ in_progress ──complete──▶ completed ──close──▶ closed
```

| Transition | Operation | Requires status | Permission |
|---|---|---|---|
| create | `workorder/create` | — | `workorder:create` |
| assign technician | `workorder/assign` | `planned` | `workorder:assign` |
| start work | `workorder/start` | `planned` | `workorder:report` |
| report time | `workorder/report-time` | `planned` or `in_progress` | `workorder:report` |
| report material | `workorder/report-material` | `planned` or `in_progress` | `workorder:report` |
| complete (with billable lines) | `workorder/complete` | `in_progress` | `workorder:complete` |
| close | `workorder/close` | `completed` | `workorder:close` |

Invalid transitions throw — a `completed` order cannot be started, a `planned` order
cannot be completed. The engine owns this; no caller can skip a state.

**Invariants beyond the state machine:**

- **Time and material are append-only.** There is no update or delete operation for
  reported entries. Corrections are a vertical-level concern (a compensating entry),
  never a silent edit — this is what makes the reporting trail trustworthy.
- **Every mutation emits an event** with the relevant payload (see below).
- **The reporter is the principal.** Time entries record `ctx.principal` as the
  technician; material lines record the reporter. Attribution comes from the ambient
  context, not from the input.

## Domain model

Created by migration `0001-init`, inside each scope's own database:

- **`workorder_orders`** — id, sequential `number` (per scope), `facility` and
  `customer` as opaque `EntityRef` columns, vertical-defined `kind`, title/description,
  status, assignment, provenance (`created_by`, `created_at`, `completed_at`).
- **`workorder_time_entries`** — order, technician, decimal `hours`, note, `reported_at`.
- **`workorder_material_lines`** — order, article, decimal `qty`, note, reporter,
  `reported_at`.

Notice what's *absent*: no facility table, no customer table, no price columns. The
engine references facilities and customers as opaque refs the vertical owns, and it
records quantities, not prices — quantities are facts, prices are business decisions.

## Completion and billable lines

`complete` is where the engine meets money, and the boundary is precise: **the vertical
prices, the engine freezes.**

```ts
await stub.invoke('workorder/complete', {
  orderId,
  billable: [
    {
      article: 'TIME', description: 'Servicetekniker', qty: '2.5', unit: 'h',
      unitPrice: moneyOf('850', 'SEK'), lineTotal: moneyOf('2125', 'SEK'),
      sourceType: 'time', sourceId: timeEntryId,
    },
    // ...
  ],
});
```

Each billable line carries **provenance** (`sourceType: 'time' | 'material'`,
`sourceId`) back to the reported entry it prices. The engine validates the lines
(Zod + [exact decimal arithmetic](/concepts/money)), sums the total with `addMoney`,
transitions the order, and emits `workorder.completed` with the full billable snapshot
in the payload — a *fat event*, so downstream consumers (invoicing) never need to query
back.

## Events

| Event | piiClass | Payload highlights |
|---|---|---|
| `workorder.created` | none | order id, number, facility, customer, kind, title |
| `workorder.assigned` | pseudonymous (`subjectId` = technician) | technician |
| `workorder.started` | none | order id |
| `workorder.time-reported` | pseudonymous (`subjectId` = reporter) | entry id, hours |
| `workorder.material-reported` | none | line id, article, qty |
| `workorder.completed` | none | **billable lines + total** (the invoicing contract) |
| `workorder.closed` | none | order id |

Events that reference a person carry `piiClass: 'pseudonymous'` and the person's
`subjectId` — so a GDPR erasure can crypto-shred the person while the operational facts
(hours were worked on this order) survive.

## Permissions

Declared in the manifest with descriptions (fuel for the permission-review diff):

`workorder:create` · `workorder:read` · `workorder:assign` · `workorder:report` ·
`workorder:complete` · `workorder:close`

Typical role shapes: a *technician* gets `read` + `report`; a *coordinator* adds
`create` + `assign` + `complete`; closing (the bookkeeping-facing act) can be reserved
for back-office. Portal customers get an entity-narrowed `workorder:read`
[capability grant](/concepts/permissions#capability-grants) on their own facility — the
engine declares the edge that makes this work:

```ts
entityRelations: [{ entityType: 'workorder', parentType: 'facility' }]
```

and `create` records it with `ctx.link(orderRef, input.facility)`, so a grant on a
facility reaches the work orders under it.

## Composing from a vertical

The registered operations are default bindings. For custom flows, the engine exports
in-scope functions — `createWorkOrder`, `completeWorkOrder`, `listOrders`,
`getReportedLines` — that your own operations call in the same transaction (you own the
permission check):

```ts
import { createWorkOrder, PERM } from '@substrat-run/engine-workorder';

host.defineOperation('acme/felanmalan-to-order', async (ctx, input) => {
  assertAllowed(await ctx.check(PERM.create));
  ctx.sql.exec('UPDATE acme_tickets SET status = ? WHERE id = ?', ['converted', input.ticketId]);
  return createWorkOrder(ctx, {
    facility: ticketFacility(ctx, input.ticketId),
    customer: ticketCustomer(ctx, input.ticketId),
    kind: 'felanmalan',
    title: input.title,
  });
});
```

## What this engine will not do

- **Pricing** — no price lists, no rates, no ROT/tax logic. Verticals price.
- **Invoicing** — it emits `workorder.completed`; what happens next is the
  [invoicing engine](/engines/invoicing)'s business.
- **Scheduling** — assignment is a field, not a calendar. Dispatch/scheduling is a
  future sibling engine.
