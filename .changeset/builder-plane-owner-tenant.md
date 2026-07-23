---
'@substrat-run/contracts': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/adapter-sqlite': minor
---

**A vertical now records its owning tenant (builder-plane.md Phase 1b).** The registry
gains an `owner_tenant` column: `NULL` = platform-owned (Callout, the dashboard), a value
= the tenant that pushed it. Ownership is the gate a later phase checks for who may push
new versions and manage a vertical's non-prod channels.

- **`vertical.ownerTenant`** (contracts) — nullable branded `TenantId`; `registerVerticalInput`
  takes it optional (defaults to `null`, so a staff/platform push keeps passing
  `{slug, name, source}` unchanged).
- **Migration in each adapter** — `owner_tenant TEXT` added idempotently to the `verticals`
  table (`ensureDirectoryColumns` in sqlite, `addColumn` in `control-plane-do`), so an
  existing directory backfills to platform-owned.
- **Claim-on-first-push** — `registerVertical` fixes a slug's owner at first push: a later
  registration under a *different* owner (or an attempt to claim a platform vertical) is
  refused, naming both owners. Identical re-registration stays idempotent.

The `<tenant>/<name>` slug prefix that keeps builder slugs globally unique is constructed at
push time in a later phase; this change is the ownership column + claim mechanism it rests on.

Verified: sqlite (147) + cloudflare (146) suites pass, including a new shared assertion that
a registered owner round-trips through `listVerticals` and that a conflicting owner is refused.
