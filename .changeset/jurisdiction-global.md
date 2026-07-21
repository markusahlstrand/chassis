---
'@substrat-run/contracts': minor
---

**`jurisdiction` is now `eu | us | global` (non-nullable), defaults to `global`, and `eu`/`us` are gated at the provisioning boundary (K-32).**

Jurisdiction is fixed at provisioning and a scope's DO can never relocate (K-7), so
the storable vocabulary has to be final before the first production scope exists —
widening what can be *stored* later is a data migration, widening what is *accepted*
is a one-line change. Two findings forced the shape:

- **It was recorded but never enforced.** The only DO id minting is
  `idFromName(scopeId)`; `newUniqueId`/`ns.jurisdiction(...)` appears nowhere but a
  deferral comment. So `eu` on a scope today moves no storage and terminates no TLS.
- **`z.enum(['eu']).nullable()` made `null` mean both "unconstrained" and "nobody
  decided"**, and the provisioning input defaulted to it — so absence silently
  became a residency posture.

So: `jurisdiction = z.enum(['eu','us','global'])`, non-nullable, defaulting to
`global` (the honest name for what every scope already is — no subnamespace, placed
near first access). Legacy `null` rows coerce to `global` on read in both adapters.
A separate `provisionableJurisdiction = z.enum(['global'])` gates the control-plane
HTTP boundary: `eu`/`us` are storable but refused with 400 until their enforcement
(DO jurisdiction subnamespace, Regional Services) is built — `us` is not even a
Cloudflare DO jurisdiction, so it is a different mechanism behind the same word.
Gated exactly as `STANDALONE`/`ALLOW_DEV_HEADER` are (K-31).

No SQL migration: the columns were already nullable `TEXT`. The console's create
dialog gains a jurisdiction picker with `eu`/`us` shown-but-disabled, so the roadmap
is visible where the choice is made. Deriving `hostnameRegion` from the scope
(rather than accepting it separately) is the natural follow-up and is deferred — it
is not immutability-sensitive.

The `@substrat-run/*` published packages version together (changesets `fixed`
group), so kernel, adapter-sqlite, adapter-cloudflare, contract-tests, and
control-plane-api move with contracts.
