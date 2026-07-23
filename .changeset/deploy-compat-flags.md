---
'@substrat-run/control-plane-api': minor
'@substrat-run/cli': minor
---

**Push forwards `compatibility_flags`, and the deploy endpoint surfaces upload failures.**

A pushed vertical that needs a compat flag — `nodejs_compat` for Better Auth / any `node:*` import — was being uploaded **without** it: the CLI manifest, the deploy schema, and the WfP metadata all carried only `compatibility_date`. So the script couldn't start, Cloudflare rejected the upload, and `deployVertical` threw — which the generic handler flattened into an anonymous `500 {"error":"internal error"}`, undiagnosable without worker logs. Callout hit exactly this.

- **`compatibility_flags` now travels end to end**: `substrat push` reads it from `wrangler.jsonc` into the manifest (`deployManifest`/`VerticalBundle` gain `compatibilityFlags`), and `createWfpUploader` emits it in the script metadata.
- **The deploy endpoint wraps `deployVertical`** and returns **`502 { error, detail }`** with the runtime's actual message (the builder is authenticated — this is platform/runtime error detail, not a bad request), plus a `console.error`, instead of a blank 500.

Verified: control-plane-api suites pass, including new tests that `nodejs_compat` survives to the uploader and that an upload failure surfaces as a 502 with detail.
