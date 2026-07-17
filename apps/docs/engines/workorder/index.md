# Work-order engine

`@substrat-run/engine-workorder` — one engine covering **work orders, time reporting, and
material reporting**. One state machine, append-only reporting, and a billable snapshot
frozen at completion. It deliberately knows nothing about pricing (the vertical's job) or
invoicing (a sibling engine, reached only via events).

## At a glance

| | |
|---|---|
| **Package** | `@substrat-run/engine-workorder` |
| **Entitlement key** | `workorder` |
| **Owns** | the order state machine, append-only time & material reporting, the billable snapshot |
| **Emits** | 7 events, `workorder.created` → `workorder.closed` ([events](./events)) |
| **Consumes** | nothing — it is a source, not a sink |
| **Permissions** | 6 (`workorder:create` · `read` · `assign` · `report` · `complete` · `close`) |
| **Status** | product seed (0.x) — surfaces change until the first vertical ships |

## What it owns

- **The state machine cannot skip states.** `planned → in_progress → completed → closed`;
  invalid transitions throw. No caller can complete a planned order or restart a completed one.
- **Time and material are append-only.** No update, no delete. Corrections are compensating
  entries, never silent edits — this is what makes the reporting trail trustworthy.
- **Attribution comes from the ambient principal**, never from the input.
- **Every mutation emits a fat event.** `workorder.completed` carries the full billable
  snapshot, so downstream consumers never query back.

Details and the tables behind them: [Domain model & invariants](./model).

## What it will not do

- **Pricing** — no price lists, no rates, no ROT/tax logic. Verticals price; the engine
  records quantities and freezes what it's handed.
- **Invoicing** — it emits `workorder.completed`; what happens next is the
  [invoicing engine](/engines/invoicing/)'s business.
- **Scheduling** — assignment is a field, not a calendar. Dispatch/scheduling is a future
  sibling engine.

## Is this a good match?

| Reach for it when | Look elsewhere when |
|---|---|
| Work is dispatched as discrete jobs that move through fixed states | Work is continuous or has no meaningful lifecycle |
| You need a defensible record of *who did what, when* | You only need a task list — a to-do table is cheaper |
| Time and/or material get reported against the job | The billable unit isn't labour or parts |
| The job's completion is a **business event** others react to | Nothing downstream cares that work finished |
| Your pricing is yours and shouldn't live in shared machinery | You want the engine to price for you — it won't, by design |

The clarifying question: **does your domain have a moment where work is finished and priced,
and does anything care?** If yes, this engine owns that moment. If your answer is "we just
track status", you want a table, not an engine.

Note the scope call: work orders, time, and material are **one** engine, not three. Time
entries have no meaning outside their work order, and two engines needing chatty synchronous
talk are one engine drawn wrong.
