---
"@substrat-run/dashboard": patch
---

**Real running version on the app Overview.** The Overview tab hardcoded `v0.0.1` (and "Last
deploy just now"); it now reads the app's actual running version — the version its scope is
bound to (what the router serves) — from the same source as the Deployments tab. Shows an
"update available" hint (linking to Deployments) when prod has moved past what the app runs.
