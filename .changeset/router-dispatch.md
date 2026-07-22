---
'@substrat-run/contracts': minor
---

**The router dispatches on the scope's bound version (orchestration.md Phase 3, §5.4).**

`routeTarget` gains `deploymentRef` (nullable): the dispatch script the scope's bound
version deploys as. The directory read (`resolveHostname` / `readHostname`) now LEFT-joins
`scope → vertical_version` to resolve it in the same one DO call, so the hot path stays a
single read.

The router's `verticalFor` becomes `env.DISPATCH.get(deploymentRef)` when the namespace is
bound and the scope has a version — the one-line swap K-28 anticipated — falling back to the
static `VERTICAL_<SLUG>` service binding for a route with no version. A pushed vertical is
now reachable through the router without redeploying it. The bounded `Worker not found.`
retry (K-29), armed since K-28, is now live: it fires on the dispatch path.

Adapters (`adapter-sqlite`, `adapter-cloudflare`) version with contracts (fixed group).
