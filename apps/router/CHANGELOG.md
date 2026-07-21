# @substrat-run/router

## 0.0.5

### Patch Changes

- Updated dependencies [9c1f0bb]
- Updated dependencies [113160a]
- Updated dependencies [3fb38da]
- Updated dependencies [2becfd5]
- Updated dependencies [d881f75]
  - @substrat-run/contracts@0.10.0
  - @substrat-run/adapter-cloudflare@0.10.0

## 0.0.4

### Patch Changes

- Updated dependencies [27872cc]
  - @substrat-run/adapter-cloudflare@0.9.0
  - @substrat-run/contracts@0.9.0

## 0.0.3

### Patch Changes

- @substrat-run/contracts@0.8.0
- @substrat-run/adapter-cloudflare@0.8.0

## 0.0.2

### Patch Changes

- ad89a9d: Fix: the router built one Durable Object stub and reused it across requests.

  A DO stub is an I/O object owned by the request that created it, so reusing one
  throws `Cannot perform I/O on behalf of a different request`. The first request after
  each cold start succeeded and every request after it returned 1101 — which is why
  nothing caught it before production: every test sent a single request.

  `createRouteResolver` now creates the stub inside the returned closure, per call, and
  the router no longer memoises the resolver. Only the namespace binding may be held
  across requests; nothing derived from one may be.

  `CloudflareScopeHost` has the same shape and is safe only because every worker
  rebuilds it per request. That requirement is now stated on the constructor.

- 392ba98: The router retries a transient dispatch failure once, for bodyless requests only.

  Verifying K-28 turned up a second finding: a freshly-deployed user worker is not
  instantly reachable everywhere. One scope got `Worker not found.` for ~15s while
  sibling scopes on the same script succeeded — its Durable Object had placed in a colo
  the script had not propagated to — and it healed on its own.

  There is no propagation-complete signal to wait for, so this is not a delay. It is one
  bounded retry, which also survives being wrong about the cause: the colo explanation is
  an inference from the symptom, not something Cloudflare documents.

  Bodyless requests only. A retry is safe only when the first attempt provably had no
  effect, and replaying a POST that already reached the vertical would run the mutation
  twice.

- Updated dependencies [c54637b]
- Updated dependencies [33fb5dd]
- Updated dependencies [ad89a9d]
  - @substrat-run/contracts@0.7.0
  - @substrat-run/adapter-cloudflare@0.7.0
