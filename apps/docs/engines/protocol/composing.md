# Composing & extending

## Using it as-is

```ts
host.registerModule(protocolModule);
```

Then supply template content — the engine ships none.

## Wrapping it with vertical logic

The registered operations are default bindings over exported in-scope functions. Your own
operations call them in the same transaction, and you own the permission check:

```ts
import { instantiateProtocol, PROTOCOL_PERM } from '@substrat-run/engine-protocol';

host.defineOperation('cykel/start-condition-report', async (ctx, input) => {
  assertAllowed(await ctx.check(PROTOCOL_PERM.create));
  return instantiateProtocol(ctx, {
    templateKey: 'condition-report',
    entity: input.bike, // any EntityRef — the vertical owns the vocabulary
  });
});
```

The vertical declares the `protocol → <parent>` entity relation in *its* manifest — the engine
can't know whether protocols hang off work orders, bikes, or apartments — and supplies the
template content.

## The completion guard — two forms

"Obligatorisk för status" (a work order can't complete until its protocol is signed) is the
canonical cross-engine requirement, and there are two ways to wire it.

### Composed, in code

```ts
import { requireSigned } from '@substrat-run/engine-protocol';

host.defineOperation('acme/workorder-complete', async (ctx, input) => {
  assertAllowed(await ctx.check(WORKORDER_PERM.complete));
  requireSigned(ctx, input.order, 'egenkontroll-el'); // throws if not signed
  return completeWorkOrder(ctx, input);
});
```

The work-order engine knows nothing of protocols, the protocol engine checks its own tables,
and the *vertical* wires the two — star topology intact. The `requireSigned` call site **is**
the compliance gate.

### Declared, in the manifest

```ts
guards: [{
  before: 'bike-shop/close-repair',
  predicate: 'protocol/all-signed',
  config: { templateKey: 'condition-report', entityType: 'bike', entityIdFrom: 'bikeId' },
}]
```

Same rule, but it appears in the **reviewable manifest diff** — dropping a compliance gate
becomes visible rather than a deleted line in a handler.

Prefer the declarative form when the rule really is "this operation is blocked until X".
Prefer the composed form when the vertical needs to name a moment it actually owns — a bike
shop's *pickup*, where the customer accepts the report, is more than the engine's transition,
and a guard on `workorder/close` would describe it wrongly.

## Configuration

**There is none at registration time.** `ModuleRegistration` has five fields —
`manifest`, `migrations`, `operations`, `consumers`, `predicates` — and none is config. There
is no `createProtocolModule({...})` factory and no `config` field on the manifest.

*Configuration is dynamic; composition is code.*

This engine shows the two sanctioned alternatives better than any other:

| You want | Use |
|---|---|
| a parameterised rule | **`guards[].config`** — declared in the vertical's manifest, kernel-opaque, parsed by `allSignedGuardConfig`. Its `entityIdFrom` late-binds into your vocabulary. |
| tenant-specific content | **runtime data** — `defineTemplate` puts templates in the tenant's own scope. Which protocols exist is data, not config. |
| only part of the engine | `withdraws` in your manifest, then re-offer behind your own operation |
| different behaviour around a transition | your own operation calling the in-scope function |
| the engine off for a tenant | revoke the `protocol` entitlement |

The template mechanism is the lesson worth generalising: content that varies per tenant is
**data in the scope**, not options in a constructor. An engine with a `templates:` config
array would need a redeploy to add a checklist; `defineTemplate` needs an operation call.

### Adding data to a protocol

Never add a column upstream. A vertical needing extra fields adds **its own side table keyed
by the engine's instance id**. Another module's tables are private; the stable surface is
entity ids, `EntityRef`s, and event payloads.

## Reaching the outside world

Nothing in this engine talks to anything external, and it never will: module code may not
`fetch`, and connectors handle the outside world.

The seam here is unusually well-designed and worth studying: the `method` column on a
signature is a **reserved slot**. A BankID or Scrive connector runs the external flow and
calls the *same* `sign` operation with upgraded evidence in `evidence_ref` — a sealed PDF, a
transaction id, a provider audit log. eIDAS advanced/qualified is an evidence-quality upgrade,
not a second code path.

That's the shape to copy: the engine defines what evidence *is*, and a connector supplies a
better grade of it. There's no `signWithBankID` waiting to be written.

::: warning Connectors are not built yet
The connector interface, connection store, token refresh, and webhook ingress are **planned,
not implemented** — there is no connector code in the repo, and no signature method other than
`in-app` works today. The `_substrat_outbox` is real and transactional, but drains only to
in-process consumers.

The `method` column is a slot with nothing to put in it yet. That's deliberate sequencing —
the schema doesn't need to change when connectors land — but don't read it as BankID support.
:::
