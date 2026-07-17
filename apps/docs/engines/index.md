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
| [Work orders](/engines/workorder/) | `@substrat-run/engine-workorder` | the order state machine, append-only time & material reporting |
| [Invoicing](/engines/invoicing/) | `@substrat-run/engine-invoicing` | invoice-basis accumulation from billable events, immutability on export |
| [Protocols](/engines/protocol/) | `@substrat-run/engine-protocol` | protocols/checklists with the sign → immutable invariant, verifiable content hash |

All three are **product seeds**, extracted from the demo verticals — small deliberately,
hardened as real verticals consume them. The protocol engine is the extraction proof
itself: it was forced out of vertical code only when a *second* vertical (a bike shop's
per-bike condition report) needed the same sign-immutability invariant in a different
shape. Planned next, in the order verticals force them: scheduling/dispatch and
ticketing (ärende).

## How these pages are organized

Every engine documents itself the same way, in the same five pages. The shape is a
contract: a page that has nothing to say is a finding, not an omission.

| Page | Answers |
|---|---|
| **index** | *Is this a good match?* — what it owns, what it won't do, when to reach for it |
| **Domain model & invariants** | the tables, and the rules the engine will not let you break |
| **Operations, functions & permissions** | the callable surface, and which parts are composable |
| **Events** | what it emits and consumes, payload contracts, versioning |
| **Composing & extending** | using it from a vertical, configuration, the connector seam |

Two conventions worth knowing before you read:

**Engines have no endpoints.** They expose *operations* (named handlers invoked through a
scope stub, each doing its own permission check) and *in-scope functions* (plain exports a
vertical calls inside its own transaction, where the caller owns the check). Any HTTP surface
is generated from the manifest's `api` field, never hand-written. The split between those two
surfaces **is** the extension model, which is why every engine has a page for it.

**Engines take no configuration.** `registerModule` accepts one frozen constant; there is no
options object, no factory, and no `config` field on the manifest. When behaviour must vary,
you compose (your own operation calling in-scope functions), declare (a guard predicate with
its own kernel-opaque config), store (tenant content as data in the scope), or gate (the
entitlement flag). *Configuration is dynamic; composition is code.* The Composing page of
each engine says which of those applies, and admits where the engine doesn't yet allow it.
