# Events & audit

Every mutation in a Substrat system emits a **domain event**. Events are the audit trail,
the integration surface between engines, and the feed for reporting — one mechanism,
three jobs.

## What module code writes

```ts
ctx.emit({
  type: 'workorder.completed',   // module-namespaced
  schemaVersion: 1,
  entity: { entityType: 'workorder', entityId: order.id },
  piiClass: 'none',
  payload: { orderId: order.id, billable, total },
});
```

Everything identifying the **origin** is deliberately absent from the input. The kernel
stamps the envelope below the API surface:

```ts
type DomainEvent = {
  id: EventId;          // ULID — the idempotency key for consumers
  type: string;
  schemaVersion: number;
  occurredAt: Instant;  // stamped by kernel
  tenantId: TenantId;   // stamped by kernel
  scopeId: ScopeId;     // stamped by kernel
  actor: PrincipalId | { system: ModuleId }; // stamped from the stub's context
  entity: EntityRef;
  piiClass: 'none' | 'pseudonymous' | 'direct';
  subjectId?: DataSubjectId;
  payload: unknown;
};
```

A vertical cannot mislabel an event's origin, backdate it, attribute it to someone else,
or skip emitting where an engine emits — because the fields aren't parameters and the
emit sits inside the engine's operation, below anything the calling code controls.

## PII classification is mandatory

`piiClass` is required at the type level — an event that *could* carry personal data
cannot be declared without classifying it:

- **`none`** — no personal data in the payload.
- **`pseudonymous`** — references a person by opaque ID (a technician reporting time).
- **`direct`** — contains direct identifiers.

And the schema enforces the invariant that makes GDPR erasure implementable: **a
PII-classed event without a `subjectId` fails validation.** Crypto-shredding — erasing a
person by destroying their key — must always be able to key the erasure. Facts and
pseudonymous references survive (bookkeeping retention holds); the personal data becomes
unreadable.

## Events cross boundaries, queries don't

The composition rule for the whole system: engines and scopes integrate by **reacting to
each other's events**, never by querying each other's tables.

The [invoicing engine](/engines/invoicing) demonstrates the pattern. It declares in its
manifest:

```ts
events: {
  consumes: [{ type: 'workorder.completed', schemaVersion: 1 }],
}
```

and registers a consumer that parses **its own view** of the payload — it never imports
the producer's types:

```ts
const onWorkOrderCompleted: ConsumerHandler = (ctx, event) => {
  const p = completedPayload.parse(event.payload); // own Zod schema of the contract
  // ...write invoicing tables from the snapshot
};
```

This is a *fat event* design: the payload carries what consumers need (billable lines,
prices, totals), so the consumer snapshots rather than joins. Prices are frozen at the
moment the event happened — which is exactly what an invoice wants.

## Delivery semantics

- Consumers run as ordinary in-scope operations under a **system actor**
  (`{ system: '@substrat/engine-invoicing' }` — visible as such in the audit trail).
- Delivery is **at-least-once**, tracked in a kernel delivery journal — consumers must
  be idempotent; the event `id` is the idempotency key.
- Ordering is guaranteed only within one (scope, module) pair.

## Audit as a product feature

Because every event carries tenant, scope, actor, entity, and time — stamped, not
supplied — the event stream *is* the audit log: complete by construction, not by
discipline. "Who did what, when, to which entity" is a query, and the answer is the same
data reporting runs on.
