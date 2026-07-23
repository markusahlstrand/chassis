---
'@substrat-run/control-plane-api': minor
---

**Deploy path forwards a vertical's own D1 bindings (self-serve-deploy.md §4).**

A `substrat push` now carries a vertical's `d1_databases` through to the Workers-for-Platforms upload, so a pushed vertical actually has its own data stores — not just its `ScopeDO`. This is what a CP-less vertical like Callout needs for its Better-Auth `AUTH_DB` to exist on the deployed worker.

- **`DeclaredBinding` / `deployManifest`** gain an optional `id` — a `d1` binding's `database_id`, which previously would have been stripped at manifest parse.
- **`tools/substrat-push.mjs`** maps `wrangler.jsonc`'s `d1_databases` to `{ type: 'd1', name: <binding>, id: <database_id> }` bindings alongside the DO bindings; `createWfpUploader` already forwards the binding set verbatim into the script metadata, which is the shape Cloudflare expects for a D1 binding.
- **`assertSandboxContract`** still refuses only the platform's infrastructure (`CONTROL_PLANE`, service bindings, cross-script / foreign DO classes); a vertical's own `d1` store falls through and is allowed, matching §4 ("no `AUTH_DB` it did not create" — its own is fine). Documented open question: this check doesn't yet prove the vertical *owns* the declared `database_id` rather than pointing at another tenant's DB — under model B that gap is closed by human admission, and by per-vertical store provisioning when self-serve opens wider.

Not covered here (a separate mechanism, tracked next): **static assets.** A pushed vertical's SPA is not a binding — Cloudflare uploads it via a blake3-hashed assets-upload-session, which needs a server-side implementation in the uploader. Callout still needs that before it serves its UI from the dispatch namespace.

Verified: control-plane-api suites pass, including a new deploy test that a `d1` binding (with its `database_id`) is accepted by the sandbox contract and forwarded to the uploader.
