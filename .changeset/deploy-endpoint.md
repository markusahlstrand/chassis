---
'@substrat-run/control-plane-api': minor
---

**Add the deploy seam: `POST /verticals/:slug/deploy` (self-serve-deploy.md foundation).**

A `substrat push` uploads a *built* worker bundle to this endpoint, which validates the
**sandbox contract**, forwards the bundle to an injected uploader (the host holds the
Cloudflare credential — the builder never does, D-34), and records a **pending** version.
A push is not a deploy; admission still gates serving.

- New `deployVertical?: DeployVerticalFn` option — injected so the package holds no
  Cloudflare SDK and is unit-testable with a fake. Absent ⇒ the route 501s.
- `assertSandboxContract` (self-serve-deploy.md §4): refuses an upload whose declared
  bindings would reach platform infrastructure — a `CONTROL_PLANE` binding, a cross-script
  DO binding, or a service binding to a platform worker → `403`. Structural refusal, not
  code inspection, is the primary defence against untrusted bundles.
- `deploymentRef` is `<slug>-<versionId>` (a lowercased ULID) — a valid Cloudflare Worker
  script name, unlike the `@version` label the RFC sketched (`@`/`.` are illegal in script
  names). The human label stays on the version record.
- Exports `assertSandboxContract`, `deployManifest`, `deploymentRefFor`, and the
  `DeployVerticalFn` / `VerticalBundle` types for hosts to implement the real uploader.
- `createWfpUploader({ accountId, namespace, apiToken })` — a `DeployVerticalFn` that
  uploads the bundle into a Workers-for-Platforms dispatch namespace (pure `fetch` +
  `FormData`, so it runs in a Worker or node). Wired into `apps/control-plane` (behind the
  `CF_API_TOKEN`/`CF_ACCOUNT_ID` env) and the dev server. The `tools/substrat-push.mjs` CLI
  builds a vertical and pushes it to `/verticals/:slug/deploy`.
