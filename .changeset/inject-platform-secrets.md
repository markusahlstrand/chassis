---
'@substrat-run/control-plane-api': minor
'@substrat-run/control-plane': minor
---

**The platform injects `PLATFORM_SECRET` + `ROUTER_SECRET` into every pushed vertical.**

A pushed vertical needs the platform's shared secrets to *verify* inbound calls — `PLATFORM_SECRET` to accept the control plane's `/internal/provision` (K-31), `ROUTER_SECRET` to trust the router-asserted node (K-27). But `wrangler secret put` can't target a WfP dispatch-namespace script, so there was no clean way to set them per-vertical. And they aren't the builder's secrets — they're the platform's.

- **`createWfpUploader` gains `injectSecrets`** — a name→value map added as `secret_text` bindings on every uploaded script. Injected server-side, *after* the §4 sandbox check on the vertical's declared bindings (the platform is granting verification secrets, not the vertical reaching for a platform binding). Empty values are skipped.
- **The control plane passes `env.PLATFORM_SECRET` + `env.ROUTER_SECRET`** into the uploader, so a pushed vertical is provisionable + servable with zero per-vertical secret setup.

Set both on the control plane, redeploy, and re-push a vertical — it comes up holding the secrets it needs. Verified: control-plane-api suites pass, including new tests that the secrets land as `secret_text` bindings beside the vertical's own, and that an unset one is skipped.
