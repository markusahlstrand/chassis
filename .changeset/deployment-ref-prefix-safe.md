---
'@substrat-run/control-plane-api': patch
---

**`deploymentRefFor` is prefix-safe** — builder plane Phase 1 groundwork.

A builder-owned vertical's slug will be `<tenant>/<name>` (builder-plane.md). The
dispatch script name must stay Cloudflare-safe (`[a-z0-9_-]`), so `deploymentRefFor`
now flattens the `/` (and any other stray char) to `-`. A bare platform slug is
unaffected (`callout-<id>`), so it's fully backward-compatible.
