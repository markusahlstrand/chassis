---
"@substrat-run/control-plane-api": patch
---

**Data view: read a scope's BOUND version, not the prod channel.** The connected-mode
`/tenants/:t/scopes/:s/tables` introspection route delegated to the vertical resolved by
the vertical's `prod` channel. But each `substrat push` is a separate Workers-for-
Platforms script with its own Durable Object namespace, so a scope's data DO lives in the
deployment of the version it was **bound** to (`scope.verticalVersionId`) — the same one
the router serves it from. Once an installed app lagged prod, introspection resolved to
the prod deployment and read an empty DO.

Adds an optional `resolveVerticalVersion(slug, versionId, actor)` to `ControlPlaneApiOptions`;
the route now prefers it (keyed by the scope's bound version), falling back to the
prod-channel `resolveVertical` for a scope with no bound version, then to the host's own
scope DB. Behaviour is unchanged for a freshly-installed app (bound == prod). Closes #220.
