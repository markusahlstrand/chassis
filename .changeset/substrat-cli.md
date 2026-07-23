---
'@substrat-run/cli': minor
---

**A real `substrat` CLI — authenticated vertical deploys (replaces `tools/substrat-push.mjs`).**

The push capability is now a proper package (`@substrat-run/cli`, `bin: substrat`) with a stored credential, instead of a bare script that only worked against a dev control plane.

- **`substrat login`** stores the control-plane URL + `SERVICE_TOKEN` in `~/.substrat/config.json` (chmod 600, token prompt hidden). **`substrat push <dir> --slug --version`** builds the vertical (`wrangler --dry-run`, running its own `build.command`), assembles the manifest (DO + D1 bindings), and uploads. Auth resolves flag → env (`SUBSTRAT_CP_URL` / `SUBSTRAT_SERVICE_TOKEN`) → config.
- **Authenticates as the platform service actor via `x-service-token`** (`serviceTokenAuth`), not the dev-only `x-platform-actor` header the old script sent. That header is trusted only under `ALLOW_DEV_ACTOR=true`, so the old script could not push to a production control plane at all; this can. No `--actor` is chosen — the service token *is* the identity. No control-plane change: `serviceTokenAuth` was already wired.
- Removed `tools/substrat-push.mjs`; `pnpm substrat …` (root script) and `demos/callout/wrangler.example.jsonc` point at the CLI. Push stays PENDING — admission in the console still gates serving.

Run: `pnpm -r build` then `pnpm substrat login` → `pnpm substrat push demos/callout --slug callout --version 0.1.0`.
