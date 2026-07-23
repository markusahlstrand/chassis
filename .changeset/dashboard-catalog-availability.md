---
"@substrat-run/dashboard": patch
---

**The marketplace only offers verticals the running mode can actually provision — so it stops advertising an install that always fails.**

Adding Meridian to the catalog made it appear installable everywhere, but the hosted
dashboard runs in **connected mode**, where the shared control plane provisions via a
static `VERTICAL_<slug>` binding or a promoted dispatch-namespace version — and Meridian
has neither yet, so every install 501s ("no deployment is bound for vertical 'meridian'").
The user was offered something that couldn't be installed.

- Catalog entries now carry a `connected` flag; `GET /api/catalog` hides `connected: false`
  entries when a shared control plane is bound, and lists everything in embedded/standalone
  (which bundles each module in-process). Meridian is flagged `connected: false` until it is
  deployed + promoted to prod.
- The create-app marketplace tiles are filtered to slugs the live catalog actually offers, so
  a hidden vertical can't be picked — previously `resolveSlug` would have silently substituted
  a different vertical for a tile whose slug wasn't advertised.
- The catalog map + availability rule move to a Cloudflare-free `catalog.ts` so the gating is
  unit-tested (embedded lists Meridian; connected hides it; unknown slugs never appear).
