---
"@substrat-run/contracts": minor
"@substrat-run/kernel": minor
"@substrat-run/adapter-sqlite": minor
"@substrat-run/adapter-cloudflare": minor
"@substrat-run/contract-tests": minor
"@substrat-run/control-plane-api": minor
---

The directory becomes readable, and gets an HTTP surface.

**New package: `@substrat-run/control-plane-api`** (AGPL-3.0-only + commercial,
like the kernel it sits on). One Hono router over `HostAdmin` — the audited
control-plane transport. Web-standard only, so the same router mounts in a Worker
holding the `controlPlane` binding or behind a Node server. It is not module code:
it never receives a `ctx` and never runs in a scope's serialization domain.

**`HostAdmin` gains a read side.** The write side was complete; nothing could
enumerate what it had written.

- `listScopes(filter?)` / `getScopeRecord(tenantId, scopeId)` — the scope
  inventory §3.2 always claimed the directory was. `getScopeRecord` cross-checks
  the pair and returns `undefined` for another tenant's scope, the same
  fail-closed rule `getScope` applies (K-3).
- `listRoles(filter?)` — roles were writable and not enumerable since the
  permission model shipped. Returns `TenantRole` (a `RoleDefinition` plus its
  tenant).
- `auditLog(filter?)` widens: filter by scope, actor, action or time; `limit`,
  `cursor` and `order`. The cursor is the entry's own ULID — order is
  chronological, so a page carries its own continuation. **The default order is
  unchanged** (oldest first), so existing callers do not shift.

**The `scope` contract is now enforced rather than aspirational.** It described
`slug`/`kind`/`name`/`parentScopeId` and was parsed by nothing while the table had
none of those columns. Every read now parses through it, and `Scope` gains
`vertical`.

**`ProvisionScopeInput` extends additively** — `slug`, `kind`, `name`, `vertical`
are optional with behaviour-preserving defaults, so existing callers are
untouched. An unnamed scope's slug defaults to its lowercased id (a ULID
lowercases into a valid slug, so it is valid and unique by construction).

**`schemaVersion` and `vertical` stop being placeholders.** Both shipped as
columns written by nothing — `schemaVersion` was always `'0'`, `vertical` always
`null`. `schemaVersion` is now the applied-migration count; `vertical` is stamped
onto audit targets for scope-lifecycle actions.

**Directory schema change, applied in place by both adapters.** The `scopes` table
gains `parent_scope_id`/`slug`/`kind`/`name`/`vertical`, plus a unique index on
`(tenant_id, slug)` and one on `tenants(slug)`. The directory is not a module and
has no `SqlMigration[]` journal, so each adapter upgrades on open: add the columns,
backfill legacy rows to the same defaults `resolveScopeRecord` applies, then create
the unique indexes **after** the backfill (a unique index over NULL slugs would
permit the duplicates it exists to forbid). No action is required of callers; an
existing directory opens and migrates itself.

**Slug uniqueness is now enforced**, which it never was despite the contract saying
"unique within tenant". `createTenant` and `provisionScope` fail closed on a
collision rather than reporting a silent no-op — `INSERT OR IGNORE` would have
swallowed a colliding-slug-different-id create and reported it as idempotent.
