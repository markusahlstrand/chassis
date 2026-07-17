# Domain model & invariants

## Templates, instances, responses, signatures

Four concepts, mirrored by four tables (migration `0001-init`, inside each scope's own
database):

- **`protocol_templates`** — `key`, `version`, `title`, and `content_json` (sections → items).
  Immutable per `(key, version)`: new content is a **new version**, never an edit. Item types
  are `check` (boolean), `value` (a measurement — decimal string, with an optional `unit` like
  `MΩ`), and `text`.
- **`protocol_instances`** — a template pinned at `(key, version)` bound to an
  `entity_type`/`entity_id`, with `status` `open` → `signed` → (or) `voided`.
- **`protocol_responses`** — append-only fill entries: `item_key`, `value_json`, `note`,
  `responded_by`, `responded_at`. **Latest-per-item wins**, ordered by append (`rowid`,
  same-millisecond safe) — the history *is* audit material ("value changed from 4.2 to 5.1
  before signing").
- **`protocol_signatures`** — `signed_by`, `kind` (`primary`/`counter`), `method`,
  `content_hash`, optional `evidence_ref`. Exactly one `primary` per signed instance.

The template pins at instantiation **forever**: editing a template tomorrow never rewrites
what a signed document referred to.

## The invariants

1. **Sign freezes.** Once an instance is `signed`, any write to its responses fails at the
   engine. Filling is only possible on an `open` instance.
2. **Verifiable content hash.** At sign time the engine computes a SHA-256 over the template
   content plus the latest response per item. The recipe is the contract — anyone can replay
   it against the stored rows and compare:

   ```
   '<key>@<version>\n<content_json>\n' + 'item=value_json\n' per item, items sorted by key
   ```

   The hash is Web Crypto (`globalThis.crypto`), so the same code runs in Node, Workers, and
   the browser.
3. **Counter-signature on frozen content.** A counter-signature (the customer at pickup) is a
   *second signature row* on the **same** frozen content — the engine recomputes the hash and
   it must equal the primary's, so a counter-sign can never silently attach to changed
   content. A principal never counter-signs what they primary-signed, and never counter-signs
   twice.
4. **Append-only responses**, bound to an open instance.
5. **Every mutation emits a fat event** ([events](./events)) — a consumer never needs a
   cross-module read.
6. **Void, not delete.** A superseded protocol is `voided` (with a reason and an event), never
   mutated or removed; a replacement is a new instance.

## The signature model: provider-agnostic evidence

A signature records `signed_by` + `method` + `content_hash` + optional `evidence_ref`.

The v0 method is **`in-app`**: the authenticated principal taps sign, and integrity comes from
the engine itself — the hash, the immutability, the spine event. No third party, works
self-hosted.

Stronger methods (**`bankid`**, **`scrive`**, …) arrive later through the *same* sign
operation: a connector runs the external flow and calls sign with upgraded evidence (a sealed
PDF, a transaction id, a provider audit log) in `evidence_ref`. eIDAS advanced/qualified
levels are an **evidence-quality upgrade, not a different engine path** — which is why the
`method` column is a reserved slot rather than an enum of things the engine knows how to do.

The engine never imports a vendor SDK. (See
[Composing](./composing#reaching-the-outside-world) for what "later" means — connectors don't
exist yet.)

## Sign is separate from fill

`protocol:fill` and `protocol:sign` are deliberately distinct permissions. The field reality:
the technician fills the protocol, but only the *arbetsledare* signs it.

Filling records the responder as `ctx.principal`; signing records the signer. Attribution
comes from the ambient context, never from the input — you cannot sign as someone else by
passing their id.
