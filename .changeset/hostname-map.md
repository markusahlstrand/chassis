---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
---

The hostname map: `hostname → (tenant, scope, vertical, surface, region)`.

A provisioned scope had no URL, so "validate it works in production" had nowhere to
point. `contracts/routing.ts` adds `hostnameBinding` and `routeTarget`, and `HostAdmin`
adds `bindHostname` / `setHostnameStatus` / `listHostnames` / `resolveHostname`.

`surface` is the correction: one hostname per scope was already wrong, because a single
scope fronts a storefront and a back office, or a player app and a manager console.

`region` sits on the binding rather than in a router deployed per jurisdiction, because
Cloudflare's Regional Services is configured per hostname — residency is one more
column, not a second topology.

Bindings have a lifecycle (`pending` → `verifying` → `active`, or `failed` with a note),
since a custom domain is DNS validation and certificate issuance rather than a string
somebody sets. Only `active` resolves. `resolveHostname` takes no actor and is not
logged — the machine-path carve-out `resolveIdentity` already has — and does not
re-check suspension, which `getScope` owns.

Additive on every published surface: new schemas, new `HostAdmin` methods, new tables.
Nothing existing changed shape.
