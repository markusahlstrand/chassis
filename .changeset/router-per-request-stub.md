---
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/router': patch
---

Fix: the router built one Durable Object stub and reused it across requests.

A DO stub is an I/O object owned by the request that created it, so reusing one
throws `Cannot perform I/O on behalf of a different request`. The first request after
each cold start succeeded and every request after it returned 1101 — which is why
nothing caught it before production: every test sent a single request.

`createRouteResolver` now creates the stub inside the returned closure, per call, and
the router no longer memoises the resolver. Only the namespace binding may be held
across requests; nothing derived from one may be.

`CloudflareScopeHost` has the same shape and is safe only because every worker
rebuilds it per request. That requirement is now stated on the constructor.
