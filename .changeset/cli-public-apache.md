---
'@substrat-run/cli': minor
---

**`@substrat-run/cli` is now public — published to npm under Apache-2.0.** The deploy CLI holds
no platform IP (it builds your vertical locally and POSTs a bundle; the control plane holds the
Cloudflare credential), so it ships permissively — the industry norm for a deploy CLI — while
the rest of the platform stays AGPL + commercial.

- `private: true` removed; `publishConfig.access: public`, `repository`, `homepage`, `keywords`,
  and `engines` (`node >= 20`) added; license changed from AGPL-3.0-or-later to **Apache-2.0**
  (with a per-package `LICENSE`, shipped in the tarball).
- Install: `npm install -g @substrat-run/cli`.

Docs: the [Deploying a vertical](https://substrat.net/guide/deploying) guide is rewritten for
the builder plane (the `<workspace>/<slug>` prefix, `whoami`, `--tenant`, `promote`, the
dashboard Deployments view), a new `@substrat-run/cli` reference page is added, and the
dashboard platform page documents the Deployments tab.
