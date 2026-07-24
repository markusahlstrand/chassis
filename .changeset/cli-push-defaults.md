---
"@substrat-run/cli": minor
"@substrat-run/demo-meridian": patch
"@substrat-run/demo-callout": patch
---

**`substrat push` needs no flags.** Run it from inside the vertical and it defaults everything:

- **dir** → `.` (the current directory).
- **`--slug` / `--name`** → from a `"substrat": { "slug", "name" }` block in the vertical's
  `package.json`, or derived from the package name (`@substrat-run/demo-meridian` → `meridian`
  / `Meridian`).
- **`--version`** → the registry's latest for that slug, **patch-bumped** — no more hand-tracking
  the number (falls back to the package.json version for a slug's first-ever push).

So `cd demos/meridian && substrat push` replaces
`substrat push demos/meridian --slug meridian --version 0.0.13 --name Meridian`. Every flag still
works as an override. Adds `substrat` blocks to the Meridian + Callout demo package.json.
