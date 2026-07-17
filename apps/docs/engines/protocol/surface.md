# Operations, functions & permissions

An engine has **no endpoints**. It exposes operations (invoked through a scope stub) and
in-scope functions (called by a vertical inside its own transaction). HTTP, where it exists,
is a generated artifact pointed at by the manifest's `api` field.

This engine has a third surface the others don't: it **contributes a guard predicate**.

## Operations

| Operation | Permission | Does |
|---|---|---|
| `protocol/define-template` | `protocol:create` | register a new template version |
| `protocol/list-templates` | `protocol:read` | list registered templates |
| `protocol/instantiate` | `protocol:create` | start an instance on an entity |
| `protocol/fill` | `protocol:fill` | append a response (open instances only) |
| `protocol/sign` | `protocol:sign` | freeze the instance forever |
| `protocol/countersign` | `protocol:countersign` | add a second signature on frozen content |
| `protocol/void` | `protocol:void` | supersede an instance (never deletes) |
| `protocol/get` | `protocol:read` | one instance with responses and signatures |
| `protocol/list-for-entity` | `protocol:read` | every protocol on an `EntityRef` |

## In-scope functions

The most complete composable surface of any engine here — every operation has a function
behind it:

```ts
import { instantiateProtocol, requireSigned, PROTOCOL_PERM } from '@substrat-run/engine-protocol';
```

| Function | Notes |
|---|---|
| `defineTemplate(ctx, input)` | register a `(key, version)` |
| `listTemplates(ctx)` | |
| `instantiateProtocol(ctx, input)` | binds to any `EntityRef` |
| `fillProtocol(ctx, input)` | append-only; throws on a signed instance |
| `signProtocol(ctx, input)` | **async** — computes the content hash via Web Crypto |
| `countersignProtocol(ctx, input)` | **async** — recomputes and compares the hash |
| `voidProtocol(ctx, input)` | |
| `getProtocol(ctx, instanceId)` | |
| `listProtocolsForEntity(ctx, entity)` | |
| `protocolContentHash(ctx, …)` | **async** — the hash recipe, exported so you can verify independently |
| `requireSigned(ctx, entity, templateKey)` | throws unless signed — the completion-guard building block |
| `requireCountersigned(ctx, …)` | the counter-signed equivalent |

None of these check permissions — that is the caller's job.

`signProtocol`, `countersignProtocol`, and `protocolContentHash` are **async** because Web
Crypto is; the rest are synchronous. That `protocolContentHash` is exported at all is the
point of the invariant: the recipe is a contract you can replay, not a black box.

## The guard predicate

```ts
predicates: { 'protocol/all-signed': allSignedPredicate }
```

The engine **contributes** the predicate; a vertical manifest **wires** it. The engine
declares no guard of its own — *what is mandatory when* is vertical policy, and the engine
cannot know another module's operations.

This is the only genuinely config-shaped surface in any engine. Its config is declared in the
**vertical's** manifest, kernel-opaque, and parsed by the predicate that owns it:

```ts
export const allSignedGuardConfig = z.object({
  templateKey: z.string().min(1),   // vertical content: 'tillstandsrapport'
  entityType: z.string().min(1),    // what the protocol hangs on: 'workorder'
  entityIdFrom: z.string().min(1),  // input field holding the id: 'orderId'
  countersigned: z.boolean().default(false),
});
```

`entityIdFrom` is the trick worth stealing: it **late-binds into the vertical's vocabulary**,
so one predicate serves any operation shape without the engine ever knowing the vertical's
words. That's how you parameterise engine behaviour without a config bag — see
[Composing](./composing#configuration).

## Permissions

| Key | Description |
|---|---|
| `protocol:create` | Define protocol templates and start protocol instances on entities |
| `protocol:fill` | Record responses on an open protocol (append-only) |
| `protocol:sign` | Sign a protocol — freezes it forever (the technician fills, the arbetsledare signs) |
| `protocol:countersign` | Counter-sign an already-signed protocol — a second signature on the same frozen content |
| `protocol:read` | Read protocol templates, instances, responses and signatures |
| `protocol:void` | Void (supersede) a protocol — never deletes |

Six keys for what looks like one workflow, because the separations are the product:
fill ≠ sign is the arbetsledare rule, sign ≠ countersign is the customer at pickup, and
`void` is a supervisory act.

## Entitlement

`entitlementKey: 'protocol'`. Checked per invoke, fails closed. A binary SKU gate, not
configuration.
