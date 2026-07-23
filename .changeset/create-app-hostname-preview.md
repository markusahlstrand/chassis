---
'@substrat-run/dashboard-web': patch
---

**Create-app URL preview shows `.global.substrat.run`, matching the real binding.**

The Configure step previewed `<slug>.substrat.run`, but provisioning binds
`<slug>.global.substrat.run` (K-30: `<slug>.<jurisdiction>.substrat.run`, jurisdiction
defaults to `global`). Fixed the suffix so the preview matches what actually gets bound.
