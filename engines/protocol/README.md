# @substrat-run/engine-protocol

Protocol engine for [Substrat](https://github.com/substrat-run/substrat) —
checklists/protocols (egenkontroll, condition reports, inspection records) with the
**sign → immutable** invariant: versioned templates, append-only responses, a
verifiable content hash, and counter-signatures on frozen content.

The engine owns only the invariants. Template *content* — which protocols exist and
what they contain — is 100% vertical-owned, and an instance binds to any `EntityRef`
(a work order today, anything tomorrow).

**Full documentation: https://substrat.ahlstrand.es/engines/protocol**

## Invariants the engine owns

1. **Sign freezes** — any write to a signed instance's responses fails.
2. **Content hash** — SHA-256 over template content + latest responses at sign time,
   verifiable against replayed state.
3. **Counter-sign** — an *additional* signature on the same frozen content (the hash
   is recomputed and must match; a principal never counter-signs their own signature).
   Exactly one primary signature per instance.
4. **Append-only responses** — an edit is a new row; history is audit material.
5. **Version-pinned templates** — templates version immutably; an instance pins
   `(key, version)` at instantiation forever.
6. **Void, not delete** — a protocol is superseded, never mutated or removed.

## Composing from a vertical

Operations (`protocol/define-template`, `instantiate`, `fill`, `sign`, `countersign`,
`void`, `get`, `list-for-entity`) are default bindings over exported in-scope
functions your own operations can call — same transaction, your permission check:

```ts
import { instantiateProtocol, requireSigned, PROTOCOL_PERM } from '@substrat-run/engine-protocol';

host.defineOperation('acme/start-inspection', async (ctx, input) => {
  assertAllowed(await ctx.check(PROTOCOL_PERM.create));
  return instantiateProtocol(ctx, {
    templateKey: 'condition-report',
    entity: input.bike, // any EntityRef — the vertical owns the vocabulary
  });
});
```

`requireSigned(ctx, entity, templateKey)` is the completion-guard building block: a
vertical can refuse to close its own entity until the protocol on it is signed.

Signing records the authenticated principal with an `in-app` method; connector-backed
methods (BankID/Scrive-class) arrive later through the same operation shape with
upgraded evidence. Signed/countersigned events carry the frozen answers in the
payload — consumers never query back.

## Related packages

- [`@substrat-run/kernel`](https://npmjs.com/package/@substrat-run/kernel) — the
  scope-host contract these operations run on
- [`@substrat-run/contracts`](https://npmjs.com/package/@substrat-run/contracts) — the
  Zod shapes (`EntityRef`, permission keys) this engine builds on

## Status

Pre-release (0.x): surfaces change without notice until the first vertical ships.
