---
'@substrat-run/demo-callout': minor
---

**Callout bundles its SPA into the worker — no `ASSETS` binding (the pushable-vertical UI).**

A pushed, sandbox-clean vertical can't serve static assets through a binding — Workers-for-Platforms uploads assets via a separate blake3 upload-session. So Callout now inlines its built SPA into the worker and serves it itself, reusing the module-upload path `substrat push` already has.

- **`scripts/gen-assets.mjs`** reads `app/dist` and generates `src/assets.generated.ts` (each file inlined as UTF-8 or base64). **`src/assets.ts`** serves it: exact-file hit, else SPA fallback to `index.html`, else 404 for a missing path that looks like a file. The worker's catch-all calls `serveAsset` instead of `env.ASSETS.fetch`.
- **`wrangler.jsonc` `build.command`** = `pnpm --dir app build && node scripts/gen-assets.mjs`, so wrangler regenerates the UI before every bundle — including the `--dry-run` a `substrat push` runs — with no extra step. `pretypecheck` regenerates for tsc (an empty map when `app/dist` is absent, so CI stays green). The generated file is gitignored.
- **Dropped the `assets` binding.** The worker's only bindings are now its own `SCOPE` DO and `AUTH_DB` — both a vertical's own stores, both allowed by the §4 sandbox contract.
- **`wrangler.example.jsonc` brought in sync** with the CP-less design it had drifted from (it still showed `CONTROL_PLANE`, the `assets` binding, and `STANDALONE`); it now documents the push-based deploy.

Verified: `demo-callout` typechecks (node + worker), the scenario + provision suites pass (16 tests), and `wrangler deploy --dry-run` bundles the worker — build command running the app build + asset inline — with exactly `SCOPE` + `AUTH_DB` and no `ASSETS`.
