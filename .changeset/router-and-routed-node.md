---
'@substrat-run/kernel': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contracts': patch
---

Verticals can serve more than one tenant: the router's side of K-26, plus K-27.

`@substrat-run/kernel` exports **`readRoutedNode`**, which reads the `(tenant, scope,
surface)` a router asserted in `x-substrat-*` headers and decides whether to trust it.
Three outcomes, kept distinct: `null` when no router fronted the request (a standalone
deploy substitutes its own node), a throw when the assertion is present but unsigned,
incomplete or malformed, and the node when it is good. Collapsing the middle case into
`null` would let a forged assertion fall through to whatever the caller does for
"unrouted".

Trust comes from a shared secret, compared in constant time. K-26's real boundary is
that vertical workers have no public route — but that is a deployment fact and
`workers.dev` is on by default, so the secret is what makes the boundary hold in code
when the configuration slips.

`@substrat-run/adapter-cloudflare` adds a **`/routing` subpath export** with
`createRouteResolver`: hostname → route target over the control-plane DO, and nothing
else. The package root re-exports the scope-DO class, which a router must not carry —
it resolves a name and forwards, and should not be able to open a scope at all.

`@substrat-run/contracts` now **normalizes hostnames to lower case** in the schema.
DNS is case-insensitive, so storing `ACME.example.com` and `acme.example.com` as two
rows would let two scopes each hold "the same" hostname and let a request resolve to
whichever casing it arrived in.

Additive: new exports and a new subpath. Nothing existing changed shape.
