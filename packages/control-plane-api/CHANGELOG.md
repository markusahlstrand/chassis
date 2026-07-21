# @substrat-run/control-plane-api

## 0.11.0

### Patch Changes

- Updated dependencies [7e17b16]
- Updated dependencies [858912e]
- Updated dependencies [e4db6ed]
- Updated dependencies [e4db6ed]
  - @substrat-run/kernel@0.11.0
  - @substrat-run/contracts@0.11.0

## 0.10.0

### Patch Changes

- Updated dependencies [9c1f0bb]
- Updated dependencies [113160a]
- Updated dependencies [3fb38da]
- Updated dependencies [2becfd5]
- Updated dependencies [d881f75]
  - @substrat-run/contracts@0.10.0
  - @substrat-run/kernel@0.10.0

## 0.9.0

### Minor Changes

- 27872cc: Scopes are provisioned as `provisioning` and activated on confirmation (K-31).

  `provisionScope` wrote the directory row as `active`, so the row claimed a usable
  scope before anything had built one — and only the vertical can build one, because the
  DO class bundles the modules and lives in the vertical's deployment. The `provisioning`
  state existed in the enum for exactly this and was unused.

  `HostAdmin.activateScope` moves `provisioning → active`, through the same transition
  graph the other lifecycle moves use, so it is audited and cannot revive a suspended
  scope. `getScope` refuses anything not active, so an unconfirmed row is inert rather
  than misleading.

  `ControlPlaneClient.activateScope` is the push-mode equivalent, and the control-plane
  API gains `POST /tenants/:t/scopes/:s/activate`.

  Migrations are still attempted for a `provisioning` scope before it is refused, so the
  lazy retry and its attempt counter survive — they are the only self-healing there is
  until the reconciliation sweep exists. A scope held back by a failed migration now
  reports the migration error rather than a bare "not active".

### Patch Changes

- Updated dependencies [27872cc]
  - @substrat-run/kernel@0.9.0
  - @substrat-run/contracts@0.9.0

## 0.8.0

### Minor Changes

- c9fe555: `VerticalClient` and `POST /verticals/:slug/instances` — the platform's side of K-31.

  Provisioning is control-plane-driven because only the vertical can create a usable
  scope DO: the DO class bundles the modules and lives in the vertical's own deployment.
  This is the mirror of `ControlPlaneClient`, pointing the other way — that one is a
  vertical talking up to the platform, this is the platform telling a vertical to act.

  Deliberately tiny. Provisioning is the only thing the platform asks a vertical to do,
  and every additional verb would be authority the platform holds over someone else's
  code.

  `createControlPlaneApi` takes an optional `verticals` map. A slug with no binding gets
  a **501** rather than a silent success: a control plane that does nothing while
  reporting success is worse than one that says it cannot. The vertical's own status is
  propagated rather than flattened to 500, because a 403 means the platform secrets do
  not match — a deployment error someone must act on.

### Patch Changes

- @substrat-run/contracts@0.8.0
- @substrat-run/kernel@0.8.0

## 0.7.0

### Minor Changes

- 017bb83: The hostname map is on the audited HTTP surface: `GET /hostnames`,
  `POST /hostnames`, `PATCH /hostnames/:hostname/status`.

  `resolveHostname` is deliberately **not** here. It is the router's per-request machine
  path, unaudited by design (K-24), and the router reads the directory directly. Putting
  it on the staff surface would either flood the admin log or quietly add an unaudited
  route to a surface whose whole claim is that it is audited.

  `ControlPlaneClient` is unchanged: that is the _vertical's_ client, and a vertical
  assigning itself a domain is not a thing we want to be possible.

### Patch Changes

- Updated dependencies [c54637b]
- Updated dependencies [8c48c93]
- Updated dependencies [33fb5dd]
  - @substrat-run/contracts@0.7.0
  - @substrat-run/kernel@0.7.0

## 0.6.0

### Minor Changes

- ea3c5de: Service auth for connected verticals, and a workerd fetch fix.

  - `serviceTokenAuth` + `SERVICE_TOKEN_HEADER` — a shared-token credential a
    vertical presents to register into the control plane (a service, not staff),
    and `firstPlatformActorAuth` to compose it with session/dev auth.
  - `ControlPlaneClient` gains a `serviceToken` option (sent as `x-service-token`).
  - **Fix:** `ControlPlaneClient` bound `globalThis.fetch` incorrectly, throwing
    "Illegal invocation" on workerd. It is now bound to the global scope, so the
    client works inside a Worker (over a service binding or plain fetch).

### Patch Changes

- @substrat-run/contracts@0.6.0
- @substrat-run/kernel@0.6.0

## 0.5.0

### Minor Changes

- 54c6583: Add the vertical-side connect seam and swappable staff auth.

  - `ControlPlaneClient` — a typed HTTP client that registers a tenant, entitlements,
    and scope into a separately-run control plane, plus `assertScopeActive`, a gate
    that fails closed on the directory's authoritative lifecycle (tenant-level
    cascade included). `fetch` is injectable.
  - `sessionPlatformAuth(readSession, resolveActor)` + `staffAllowlist` — the real
    `PlatformActorAuth` for platform staff, split so the auth provider and the staff
    roster are independent. Swapping the provider (e.g. to AuthHero) changes only the
    session reader.

### Patch Changes

- @substrat-run/contracts@0.5.0
- @substrat-run/kernel@0.5.0

## 0.4.0

### Minor Changes

- 6900431: The directory becomes readable, and gets an HTTP surface.

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

### Patch Changes

- Updated dependencies [6900431]
  - @substrat-run/contracts@0.4.0
  - @substrat-run/kernel@0.4.0
