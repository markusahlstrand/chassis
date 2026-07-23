---
'@substrat-run/dashboard': minor
---

**Deployments view — the builder-facing mirror of the console (builder-plane.md Phase 4).**
A customer now sees the verticals they pushed, right in their dashboard: each version's
admission state and which channel points where, and can self-serve `dev`/`staging`
promotion. Production stays a staff decision (model B) — shown, not actionable.

- **`GET /api/deployments`** — the tenant's own verticals (`ownerTenant === tenant`), each
  with its versions + channels. Connected mode reads the shared control plane
  (tenant-filtered); embedded reads the local host. The tenant is the caller's own, from
  their session — never a request argument.
- **`POST /api/deployments/:slug/promote`** — points a NON-prod channel at a version.
  `prod` is refused (403 — "promoted by the Substrat team"), and the slug is verified to be
  one of the caller's **own** deployments first (a slug you don't own reads as 404), so the
  dashboard's staff-level service token can't be used to touch another tenant's vertical.
- **The view** (`Deployments.tsx`, a new sidebar entry) — per vertical, a version table with
  admission pills, the channels each version holds, and `→ dev` / `→ staging` buttons
  (enabled only for an admitted version). The `<tenantSlug>/` prefix is stripped for
  display; a builder sees the bare name they pushed.

The CP client (`TenantNarrowedControlPlane`) gains `listVerticals` (tenant-filtered),
`listVersions`, and `promote`; the assembly + ownership check live in a testable
`deployments.ts`.

Verified: dashboard suite (14) incl. new assertions — a tenant sees only its own verticals
(not platform, not another tenant's), shaped with channels and newest-first versions, and a
slug it doesn't own is not promotable; `pnpm -r typecheck` and the web build both pass.
