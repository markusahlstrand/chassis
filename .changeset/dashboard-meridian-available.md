---
"@substrat-run/dashboard": patch
---

**Offer Meridian in the hosted marketplace.** Meridian is deployed to the `substrat-verticals`
dispatch namespace and promoted to prod, so its catalog `connected` flag flips to `true` — the
`/apps/new` marketplace now lists it and installs provision a real instance. (It was `connected:
false` while it wasn't yet deployable, which is why the tile was hidden even though the CLI showed
the version admitted.) Requires redeploying the dashboard.
