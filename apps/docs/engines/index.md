# What is an engine?

An **engine** is domain machinery shared across verticals but too domain-shaped for the
kernel: work orders, invoicing, scheduling, ticketing, protocols/checklists. Engines are
headless, versioned npm packages that register into a scope host as
[modules](/concepts/modules) — no UI framework, no HTTP server, no storage of their own
beyond the tables their migrations create inside each scope.

## The division of labor

**Engines own invariants.** State machines can't skip states. Time entries are
append-only. An exported invoice basis is immutable. Every mutation emits an event.
Every access passes a permission check.

**Verticals own everything with a user's fingerprints on it.** Vocabulary, extra states
and fields, triggers, pricing logic, screens, reports, industry content.

The design test for the boundary: **if a vertical ever needs to fork an engine, the
engine drew its line wrong.** A concrete example from the work-order engine: it has no
price list and no pricing logic — pricing differs per business, so the *vertical*
computes billable lines and hands them to `complete`. The engine enforces what must
always hold (status transitions, append-only reporting, event emission), not what any
particular business decides.

## Star topology: engines never talk to each other

No engine imports or calls a sibling — enforced by review and by design. Engines
compose through three kernel-mediated channels:

1. **Opaque refs** — an engine stores `(entityType, entityId)` without knowing what it
   is. The work-order engine binds orders to a `facility` ref it never dereferences.
2. **Events** — schema-versioned contracts on the spine. The invoicing engine consumes
   `workorder.completed` with **zero imports** from the work-order engine; it parses its
   own Zod view of the payload.
3. **Vertical-owned orchestration** — synchronous flows needing two engines are wired in
   the vertical, where the glue is visible and editable.

Why: with *N* engines talking to the kernel there are *N* contracts to keep compatible;
with engines talking to each other there are *N²*. Star topology keeps every engine
independently versionable, licensable, and replaceable.

The corollary: **if two engines need chatty synchronous communication, they are one
engine drawn wrong.** That's why "work orders + time + material" is one engine, not
three — time entries have no meaning outside their work order.

## Anatomy of an engine package

Every engine exports the same shape:

```ts
export const PERM = { /* parsed permission keys */ };
export const engineManifest = moduleManifest.parse({ /* self-description */ });
export const engineMigrations = [ /* ordered SQL */ ];

// In-scope functions — composable from vertical operations, same transaction.
export function createWorkOrder(ctx, input) { /* ... */ }

// The full registration: manifest + migrations + default operation bindings
export const engineModule: ModuleRegistration = { /* ... */ };
```

Using an engine as-is is one line:

```ts
host.registerModule(workorderModule);
```

Wrapping it with vertical logic means writing your own operation and calling the
engine's exported in-scope functions — same transaction, same serialization domain, and
the permission check becomes your responsibility:

```ts
host.defineOperation('acme/create-order', async (ctx, input) => {
  assertAllowed(await ctx.check(PERM.create));
  const order = createWorkOrder(ctx, mapToEngineInput(input));
  // your own tables, in the same transaction
  return order;
});
```

## Engines today

| Engine | Package | What it owns |
|---|---|---|
| [Work orders](/engines/workorder) | `@substrat-run/engine-workorder` | the order state machine, append-only time & material reporting |
| [Invoicing](/engines/invoicing) | `@substrat-run/engine-invoicing` | invoice-basis accumulation from billable events, immutability on export |

Both are **product seeds**, extracted from the first demo vertical (a Swedish field-service
firm) — small deliberately, hardened as real verticals consume them. Planned next, in
the order verticals force them: scheduling/dispatch, ticketing (ärende), and a
protocol/checklist engine.
