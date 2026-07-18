import { DurableObject } from 'cloudflare:workers';
import type {
  AdminLogEntry,
  RoleDefinition,
  ScopeStatus,
  Tenant,
  TenantStatus,
} from '@substrat-run/contracts';

/**
 * The durable directory (control-plane.md §4). One singleton DO, backed by its
 * own SQLite, is the WHOLE directory: the tenant registry, scope lifecycle,
 * roles, tenant-level relation tuples, entitlements, identities, and the admin
 * audit log. The coordinator (`CloudflareScopeHost`) is a stateless async router
 * that `await`s RPCs to here — nothing directory-shaped lives in the Worker
 * isolate anymore. A ScopeDO's permission checker reads `getRole`/`tenantTuples`
 * from here for the tenant-level rows it cannot reach locally.
 *
 * Every method is synchronous DO SQL; the RPC layer makes them awaitable. The
 * fail-closed cases THROW plain `Error`s (never a ZodError — the coordinator does
 * all the Zod parsing before calling in), so the message survives the RPC hop.
 * Effect methods return what the coordinator needs for the audit entry to spare
 * it a read round-trip.
 *
 * Tuple placement follows the pure adapter's checker verbatim (§4.2): scope +
 * entity tuples in the ScopeDO, tenant tuples + roles here.
 */

interface TupleRow {
  subject: string;
  relation: string;
  object: string;
  expires_at: string | null;
}

interface TenantRow {
  tenant_id: string;
  slug: string;
  name: string;
  status: string;
  created_at: string;
}

/** The raw role row; `permissions` is a JSON blob in a TEXT column. */
export interface RoleRow {
  tenant_id: string;
  role_key: string;
  permissions: string;
  source: string;
}

/** The raw directory row; the coordinator maps it through the `scope` contract. */
export interface ScopeRow {
  scope_id: string;
  tenant_id: string;
  parent_scope_id: string | null;
  slug: string;
  kind: string;
  name: string;
  vertical: string | null;
  storage_shape: string;
  jurisdiction: string | null;
  status: string;
  schema_version: string;
  migration_failed_version: string | null;
  migration_error: string | null;
  migration_attempts: number;
  migration_last_attempt_at: string | null;
  created_at: string;
}

interface AdminLogRow {
  id: string;
  actor: string;
  action: string;
  tenant_id: string;
  scope_id: string | null;
  vertical: string | null;
  before: string | null;
  after: string | null;
  at: string;
}

/** The audit filter, flattened for the RPC hop (`action` always an array or absent). */
export interface AuditLogQuery {
  tenantId?: string;
  scopeId?: string;
  actor?: string;
  action?: string[];
  since?: string;
  until?: string;
  limit?: number;
  cursor?: string;
  order?: 'asc' | 'desc';
}

/** The shape the coordinator hands `recordAdmin`; before/after are arbitrary JSON. */
export interface AdminEntryInput {
  id: string;
  actor: string;
  action: string;
  tenantId: string;
  scopeId: string | null;
  vertical: string | null;
  before: unknown;
  after: unknown;
  at: string;
}

const DIRECTORY_DDL = `
  CREATE TABLE IF NOT EXISTS tenants (
    tenant_id TEXT PRIMARY KEY,
    slug TEXT NOT NULL,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL
  );
  -- slug/kind/name/vertical are nullable here but required (except vertical) by
  -- the scope contract — the column set must match whether the table was created
  -- fresh or ALTERed up (see ensureDirectoryColumns), and SQLite cannot ADD a NOT
  -- NULL column to a populated table. Zod is the enforcement point on read.
  CREATE TABLE IF NOT EXISTS scopes (
    scope_id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    parent_scope_id TEXT,
    slug TEXT,
    kind TEXT,
    name TEXT,
    vertical TEXT,
    storage_shape TEXT NOT NULL DEFAULT 'A',
    jurisdiction TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    schema_version TEXT NOT NULL DEFAULT '0',
    -- Last FAILED migration attempt (§5.3). All null / 0 = healthy. Written on the
    -- failure path so a scope that fails closed stops rendering as active, and
    -- cleared on the next success. See ScopeDO.applyPendingMigrations.
    -- (No semicolons in this comment — see the NOTE below.)
    migration_failed_version TEXT,
    migration_error TEXT,
    migration_attempts INTEGER NOT NULL DEFAULT 0,
    migration_last_attempt_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS _substrat_tenant_tuples (
    tenant_id TEXT NOT NULL,
    subject TEXT NOT NULL,
    relation TEXT NOT NULL,
    object TEXT NOT NULL,
    expires_at TEXT,
    PRIMARY KEY (tenant_id, subject, relation, object)
  );
  CREATE TABLE IF NOT EXISTS _substrat_roles (
    tenant_id TEXT NOT NULL,
    role_key TEXT NOT NULL,
    permissions TEXT NOT NULL,
    source TEXT NOT NULL,
    PRIMARY KEY (tenant_id, role_key)
  );
  CREATE TABLE IF NOT EXISTS _substrat_entitlements (
    tenant_id TEXT NOT NULL,
    entitlement_key TEXT NOT NULL,
    PRIMARY KEY (tenant_id, entitlement_key)
  );
  CREATE TABLE IF NOT EXISTS _substrat_identities (
    provider     TEXT NOT NULL,
    external_id  TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    tenant_id    TEXT NOT NULL,
    scope_id     TEXT,
    created_at   TEXT NOT NULL,
    PRIMARY KEY (provider, external_id)
  );
  CREATE TABLE IF NOT EXISTS _substrat_admin_log (
    id TEXT PRIMARY KEY,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    scope_id TEXT,
    vertical TEXT,
    before TEXT,
    after TEXT,
    at TEXT NOT NULL
  );
  -- Read-path indexes for the console (control-plane.md §4.5). The admin log is
  -- append-only and only grows, so every filter it offers needs one.
  -- NOTE: keep every comment in this DDL free of semicolons. The constructor
  -- splits this string on the statement separator, and a semicolon inside a
  -- comment strands a comment-only fragment that execs as "no statement".
  CREATE INDEX IF NOT EXISTS _substrat_admin_log_tenant ON _substrat_admin_log (tenant_id, id);
  CREATE INDEX IF NOT EXISTS _substrat_admin_log_scope ON _substrat_admin_log (scope_id, id);
  CREATE INDEX IF NOT EXISTS _substrat_admin_log_actor ON _substrat_admin_log (actor, id);
  CREATE INDEX IF NOT EXISTS _substrat_admin_log_action ON _substrat_admin_log (action, id);
  CREATE INDEX IF NOT EXISTS _substrat_admin_log_at ON _substrat_admin_log (at);
  CREATE INDEX IF NOT EXISTS scopes_tenant ON scopes (tenant_id, scope_id);
`;

/** The scope columns added after the directory's first shape shipped. */
const SCOPE_COLUMNS_ADDED = [
  'parent_scope_id TEXT',
  'slug TEXT',
  'kind TEXT',
  'name TEXT',
  'vertical TEXT',
  'migration_failed_version TEXT',
  'migration_error TEXT',
  'migration_attempts INTEGER NOT NULL DEFAULT 0',
  'migration_last_attempt_at TEXT',
] as const;

export class ControlPlaneDO extends DurableObject {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    this.sql = ctx.storage.sql;
    for (const stmt of DIRECTORY_DDL.split(';')) {
      const s = stmt.trim();
      if (s) this.sql.exec(s);
    }
    this.ensureDirectoryColumns();
  }

  /**
   * The directory's own migration path (control-plane.md §7). A singleton DO that
   * was created before the scope record grew its naming columns keeps its storage
   * across a deploy, so the DDL above — all `IF NOT EXISTS` — would leave it on
   * the old shape. ALTER the columns in, backfill to the same defaults
   * `resolveScopeRecord` applies, then add the uniqueness the contract claims.
   *
   * The ALTER is attempted-and-tolerated rather than guarded by a column probe:
   * DO SQLite restricts PRAGMA, so `table_info` is not reliably available here
   * (the pure adapter, which has it, probes instead). A duplicate column is the
   * expected steady state on every cold start after the first — anything else
   * rethrows.
   */
  private ensureDirectoryColumns(): void {
    for (const ddl of SCOPE_COLUMNS_ADDED) {
      try {
        this.sql.exec(`ALTER TABLE scopes ADD COLUMN ${ddl}`);
      } catch (err) {
        if (!/duplicate column name/i.test((err as Error).message)) throw err;
      }
    }
    this.sql.exec("UPDATE scopes SET slug = lower(scope_id) WHERE slug IS NULL");
    this.sql.exec("UPDATE scopes SET kind = 'scope' WHERE kind IS NULL");
    this.sql.exec('UPDATE scopes SET name = slug WHERE name IS NULL');
    // After the backfill: a UNIQUE index over NULL slugs would permit the
    // duplicates it exists to forbid (SQLite treats NULLs as distinct).
    this.sql.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS scopes_tenant_slug ON scopes (tenant_id, slug)',
    );
    this.sql.exec('CREATE UNIQUE INDEX IF NOT EXISTS tenants_slug ON tenants (slug)');
  }

  // -- tenant registry (control-plane.md §4.1) --------------------------------

  private mapTenant(r: TenantRow): Tenant {
    return {
      id: r.tenant_id,
      slug: r.slug,
      name: r.name,
      status: r.status,
      createdAt: r.created_at,
    } as Tenant;
  }

  private readTenant(tenantId: string): Tenant | undefined {
    const row = this.sql
      .exec('SELECT * FROM tenants WHERE tenant_id = ?', tenantId)
      .toArray()[0] as TenantRow | undefined;
    return row ? this.mapTenant(row) : undefined;
  }

  /** Idempotent on the id; return the new tenant, or null if it already existed. */
  createTenant(id: string, slug: string, name: string, createdAt: string): Tenant | null {
    if (this.readTenant(id)) return null; // idempotent — nothing created
    // Checked explicitly rather than left to `INSERT OR IGNORE` + the
    // `tenants_slug` UNIQUE index: OR IGNORE would swallow a collision from a
    // DIFFERENT id and report the create as idempotent, silently not creating the
    // tenant the caller asked for. Fail closed instead.
    const slugOwner = this.sql
      .exec('SELECT tenant_id FROM tenants WHERE slug = ?', slug)
      .toArray()[0] as { tenant_id: string } | undefined;
    if (slugOwner) {
      throw new Error(`tenant slug '${slug}' already taken by ${slugOwner.tenant_id} (slugs are unique)`);
    }
    this.sql.exec(
      `INSERT INTO tenants (tenant_id, slug, name, status, created_at)
       VALUES (?, ?, ?, 'active', ?)`,
      id,
      slug,
      name,
      createdAt,
    );
    return this.readTenant(id) ?? null;
  }

  /** Throw if absent; else UPDATE and return the previous status. */
  setTenantStatus(tenantId: string, status: TenantStatus): string {
    const before = this.readTenant(tenantId);
    if (!before) throw new Error(`unknown tenant: ${tenantId}`);
    this.sql.exec('UPDATE tenants SET status = ? WHERE tenant_id = ?', status, tenantId);
    return before.status;
  }

  getTenant(tenantId: string): Tenant | undefined {
    return this.readTenant(tenantId);
  }

  listTenants(): Tenant[] {
    return (
      this.sql.exec('SELECT * FROM tenants ORDER BY tenant_id').toArray() as unknown as TenantRow[]
    ).map((r) => this.mapTenant(r));
  }

  // -- scope lifecycle (control-plane.md §4.1/§4.2) ---------------------------

  /**
   * Mandatory active tenant: a scope with no tenant record is the "tenant is an
   * FK string" hole the registry closes — fail closed. INSERT OR IGNORE the
   * scope with status 'active'; return whether it was newly created.
   */
  provisionScope(
    tenantId: string,
    scopeId: string,
    record: {
      slug: string;
      kind: string;
      name: string;
      vertical: string | null;
      storageShape: string;
      jurisdiction: string | null;
    },
    createdAt: string,
  ): boolean {
    const tenantRow = this.sql
      .exec('SELECT status FROM tenants WHERE tenant_id = ?', tenantId)
      .toArray()[0] as { status: string } | undefined;
    if (!tenantRow) {
      throw new Error(`cannot provision scope under unknown tenant: ${tenantId}`);
    }
    if (tenantRow.status !== 'active') {
      throw new Error(
        `cannot provision scope under non-active tenant (status: ${tenantRow.status}): ${tenantId}`,
      );
    }
    // Idempotency is on the scope_id (§3.3: idempotent and journaled — safe to
    // re-run), so an existing scope short-circuits before the slug check:
    // re-provisioning must not collide with itself.
    const existed =
      this.sql.exec('SELECT 1 FROM scopes WHERE scope_id = ?', scopeId).toArray()[0] !== undefined;
    if (!existed) {
      const slugOwner = this.sql
        .exec('SELECT scope_id FROM scopes WHERE tenant_id = ? AND slug = ?', tenantId, record.slug)
        .toArray()[0] as { scope_id: string } | undefined;
      if (slugOwner) {
        throw new Error(
          `scope slug '${record.slug}' already taken under tenant ${tenantId} ` +
            `by ${slugOwner.scope_id} (slugs are unique within a tenant)`,
        );
      }
      this.sql.exec(
        `INSERT INTO scopes
           (scope_id, tenant_id, parent_scope_id, slug, kind, name, vertical,
            storage_shape, jurisdiction, status, created_at)
         VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, 'active', ?)`,
        scopeId,
        tenantId,
        record.slug,
        record.kind,
        record.name,
        record.vertical,
        record.storageShape,
        record.jurisdiction,
        createdAt,
      );
    }
    return !existed;
  }

  /**
   * The scope's migration state, projected into the directory so the fleet
   * question ("which scopes are behind?") is answerable from the index alone —
   * §5.4's "fleet questions never fan out". Written by the coordinator after the
   * ScopeDO reports what it applied.
   *
   * Written on the FAILURE path too (#32): projecting only on success is what let
   * a half-migrated scope keep a stale `schema_version` and render as healthy.
   * `failure` null clears the columns, so `migration_attempts` counts *consecutive*
   * failures — what the reconciliation sweep's backoff (#49) needs.
   */
  setMigrationState(
    scopeId: string,
    schemaVersion: string,
    failure: { version: string; error: string } | null,
  ): void {
    if (!failure) {
      this.sql.exec(
        `UPDATE scopes SET schema_version = ?, migration_failed_version = NULL,
           migration_error = NULL, migration_attempts = 0, migration_last_attempt_at = NULL
         WHERE scope_id = ?`,
        schemaVersion,
        scopeId,
      );
      return;
    }
    this.sql.exec(
      `UPDATE scopes SET schema_version = ?, migration_failed_version = ?,
         migration_error = ?, migration_attempts = migration_attempts + 1,
         migration_last_attempt_at = ?
       WHERE scope_id = ?`,
      schemaVersion,
      failure.version,
      failure.error,
      new Date().toISOString(),
      scopeId,
    );
  }

  listScopes(filter: {
    tenantId?: string;
    status?: string[];
    vertical?: string;
  }): ScopeRow[] {
    const where: string[] = [];
    const params: string[] = [];
    if (filter.tenantId) {
      where.push('tenant_id = ?');
      params.push(filter.tenantId);
    }
    if (filter.status) {
      // An empty array means "no status is acceptable" — match nothing, rather
      // than degenerating into an unfiltered read of the whole fleet.
      if (filter.status.length === 0) return [];
      where.push(`status IN (${filter.status.map(() => '?').join(', ')})`);
      params.push(...filter.status);
    }
    if (filter.vertical) {
      where.push('vertical = ?');
      params.push(filter.vertical);
    }
    const sql =
      'SELECT * FROM scopes' +
      (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
      ' ORDER BY scope_id';
    return this.sql.exec(sql, ...params).toArray() as unknown as ScopeRow[];
  }

  /** Cross-checks the pair (K-3): a scope under a DIFFERENT tenant reads as absent. */
  getScopeRecord(tenantId: string, scopeId: string): ScopeRow | undefined {
    const row = this.sql
      .exec('SELECT * FROM scopes WHERE scope_id = ?', scopeId)
      .toArray()[0] as ScopeRow | undefined;
    if (!row || row.tenant_id !== tenantId) return undefined;
    return row;
  }

  /**
   * The getScope gate (control-plane.md §4.1/§4.2): validate the scope belongs
   * to the tenant and both records are active, or throw the fail-closed reason.
   */
  validateScopeAccess(tenantId: string, scopeId: string): void {
    const row = this.sql
      .exec('SELECT tenant_id, status FROM scopes WHERE scope_id = ?', scopeId)
      .toArray()[0] as { tenant_id: string; status: string } | undefined;
    if (!row || row.tenant_id !== tenantId) {
      throw new Error(`unknown scope for tenant: (${tenantId}, ${scopeId})`);
    }
    const tenantRow = this.sql
      .exec('SELECT status FROM tenants WHERE tenant_id = ?', tenantId)
      .toArray()[0] as { status: string } | undefined;
    if (!tenantRow) {
      throw new Error(`scope has no tenant record: (${tenantId}, ${scopeId})`);
    }
    if (tenantRow.status !== 'active') {
      throw new Error(`tenant not active (status: ${tenantRow.status}): ${tenantId}`);
    }
    if (row.status !== 'active') {
      throw new Error(`scope not active (status: ${row.status}): ${scopeId}`);
    }
  }

  /**
   * Validate ownership, enforce the legal transition graph (fail closed on an
   * illegal one), flip the status. Returns the previous status AND the scope's
   * vertical — both for the audit entry, sparing the coordinator a read
   * round-trip. `action` rides along only to name the illegal-transition message.
   */
  transitionScope(
    tenantId: string,
    scopeId: string,
    from: string[],
    to: ScopeStatus,
    action: string,
  ): { status: string; vertical: string | null } {
    const row = this.sql
      .exec('SELECT tenant_id, status, vertical FROM scopes WHERE scope_id = ?', scopeId)
      .toArray()[0] as { tenant_id: string; status: string; vertical: string | null } | undefined;
    if (!row || row.tenant_id !== tenantId) {
      throw new Error(`unknown scope for tenant: (${tenantId}, ${scopeId})`);
    }
    if (!from.includes(row.status)) {
      throw new Error(
        `illegal scope transition for ${action}: ${row.status} → ${to} ` +
          `(allowed from: ${from.join('|')})`,
      );
    }
    this.sql.exec('UPDATE scopes SET status = ? WHERE scope_id = ?', to, scopeId);
    return { status: row.status, vertical: row.vertical };
  }

  // -- roles (checker rule 1) -------------------------------------------------

  /** INSERT OR REPLACE; return the previous role (for the audit `before`) or null. */
  defineRole(tenantId: string, role: RoleDefinition): RoleDefinition | null {
    const before = this.getRole(tenantId, role.key) ?? null;
    this.sql.exec(
      `INSERT OR REPLACE INTO _substrat_roles (tenant_id, role_key, permissions, source)
       VALUES (?, ?, ?, ?)`,
      tenantId,
      role.key,
      JSON.stringify(role.permissions),
      String(role.source),
    );
    return before;
  }

  /** Raw rows; the coordinator parses them through the `tenantRole` contract. */
  listRoles(filter: { tenantId?: string; source?: string }): RoleRow[] {
    const where: string[] = [];
    const params: string[] = [];
    if (filter.tenantId) {
      where.push('tenant_id = ?');
      params.push(filter.tenantId);
    }
    if (filter.source) {
      where.push('source = ?');
      params.push(filter.source);
    }
    const sql =
      'SELECT tenant_id, role_key, permissions, source FROM _substrat_roles' +
      (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
      ' ORDER BY tenant_id, role_key';
    return this.sql.exec(sql, ...params).toArray() as unknown as RoleRow[];
  }

  getRole(tenantId: string, key: string): RoleDefinition | undefined {
    const row = this.sql
      .exec(
        'SELECT role_key, permissions, source FROM _substrat_roles WHERE tenant_id = ? AND role_key = ?',
        tenantId,
        key,
      )
      .toArray()[0] as { role_key: string; permissions: string; source: string } | undefined;
    if (!row) return undefined;
    return {
      key: row.role_key,
      permissions: JSON.parse(row.permissions),
      source: row.source,
    } as RoleDefinition;
  }

  // -- tenant-level tuples (checker rules 1, 2, 4) ----------------------------

  writeTenantTuple(
    tenantId: string,
    subject: string,
    relation: string,
    object: string,
    expiresAt: string | null,
  ): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO _substrat_tenant_tuples
         (tenant_id, subject, relation, object, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
      tenantId,
      subject,
      relation,
      object,
      expiresAt,
    );
  }

  tenantTuples(tenantId: string, subject: string, relationPrefix: string): TupleRow[] {
    return this.sql
      .exec(
        `SELECT subject, relation, object, expires_at FROM _substrat_tenant_tuples
         WHERE tenant_id = ? AND subject = ? AND relation LIKE ?`,
        tenantId,
        subject,
        `${relationPrefix}%`,
      )
      .toArray() as unknown as TupleRow[];
  }

  // -- entitlements (control-plane.md §4.3) -----------------------------------

  /** INSERT OR IGNORE; return whether it changed (idempotent). */
  grantEntitlement(tenantId: string, key: string): boolean {
    if (this.tenantHoldsEntitlement(tenantId, key)) return false;
    this.sql.exec(
      `INSERT OR IGNORE INTO _substrat_entitlements (tenant_id, entitlement_key)
       VALUES (?, ?)`,
      tenantId,
      key,
    );
    return true;
  }

  /** DELETE; return whether it changed (idempotent). */
  revokeEntitlement(tenantId: string, key: string): boolean {
    if (!this.tenantHoldsEntitlement(tenantId, key)) return false;
    this.sql.exec(
      'DELETE FROM _substrat_entitlements WHERE tenant_id = ? AND entitlement_key = ?',
      tenantId,
      key,
    );
    return true;
  }

  tenantHoldsEntitlement(tenantId: string, key: string): boolean {
    return (
      this.sql
        .exec(
          'SELECT 1 FROM _substrat_entitlements WHERE tenant_id = ? AND entitlement_key = ?',
          tenantId,
          key,
        )
        .toArray()[0] !== undefined
    );
  }

  listEntitlements(tenantId: string): string[] {
    return (
      this.sql
        .exec(
          'SELECT entitlement_key FROM _substrat_entitlements WHERE tenant_id = ? ORDER BY entitlement_key',
          tenantId,
        )
        .toArray() as unknown as { entitlement_key: string }[]
    ).map((r) => r.entitlement_key);
  }

  // -- identities (D-16; control-plane.md §6) ---------------------------------

  /** INSERT OR IGNORE; return whether it changed (idempotent). */
  linkIdentity(
    provider: string,
    externalId: string,
    principal: string,
    tenantId: string,
    scopeId: string | null,
    createdAt: string,
  ): boolean {
    const existed =
      this.sql
        .exec(
          'SELECT 1 FROM _substrat_identities WHERE provider = ? AND external_id = ?',
          provider,
          externalId,
        )
        .toArray()[0] !== undefined;
    if (existed) return false;
    this.sql.exec(
      `INSERT OR IGNORE INTO _substrat_identities
         (provider, external_id, principal_id, tenant_id, scope_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      provider,
      externalId,
      principal,
      tenantId,
      scopeId,
      createdAt,
    );
    return true;
  }

  resolveIdentity(
    provider: string,
    externalId: string,
  ): { principal: string; tenantId: string; scopeId: string | null } | undefined {
    const row = this.sql
      .exec(
        `SELECT principal_id, tenant_id, scope_id FROM _substrat_identities
         WHERE provider = ? AND external_id = ?`,
        provider,
        externalId,
      )
      .toArray()[0] as
      | { principal_id: string; tenant_id: string; scope_id: string | null }
      | undefined;
    if (!row) return undefined;
    return { principal: row.principal_id, tenantId: row.tenant_id, scopeId: row.scope_id };
  }

  // -- admin audit log (control-plane.md §4.4) --------------------------------

  /** Append one audit row. before/after are arbitrary JSON, stringified here. */
  recordAdmin(entry: AdminEntryInput): void {
    this.sql.exec(
      `INSERT INTO _substrat_admin_log
         (id, actor, action, tenant_id, scope_id, vertical, before, after, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      entry.id,
      entry.actor,
      entry.action,
      entry.tenantId,
      entry.scopeId,
      entry.vertical,
      entry.before == null ? null : JSON.stringify(entry.before),
      entry.after == null ? null : JSON.stringify(entry.after),
      entry.at,
    );
  }

  auditLog(query: AuditLogQuery): AdminLogEntry[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (query.tenantId) {
      where.push('tenant_id = ?');
      params.push(query.tenantId);
    }
    if (query.scopeId) {
      where.push('scope_id = ?');
      params.push(query.scopeId);
    }
    if (query.actor) {
      where.push('actor = ?');
      params.push(query.actor);
    }
    if (query.action) {
      if (query.action.length === 0) return []; // no action is acceptable — match nothing
      where.push(`action IN (${query.action.map(() => '?').join(', ')})`);
      params.push(...query.action);
    }
    if (query.since) {
      where.push('at >= ?');
      params.push(query.since);
    }
    if (query.until) {
      where.push('at < ?');
      params.push(query.until);
    }
    const order = query.order === 'desc' ? 'DESC' : 'ASC';
    if (query.cursor) {
      // ULID order is chronological, so the entry id IS the cursor.
      where.push(order === 'DESC' ? 'id < ?' : 'id > ?');
      params.push(query.cursor);
    }
    let sql =
      'SELECT * FROM _substrat_admin_log' +
      (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
      ` ORDER BY id ${order}`;
    if (query.limit !== undefined) {
      sql += ' LIMIT ?';
      params.push(query.limit);
    }
    const rows = this.sql.exec(sql, ...params).toArray() as unknown as AdminLogRow[];
    return rows.map(
      (r) =>
        ({
          id: r.id,
          actor: r.actor,
          action: r.action,
          tenantId: r.tenant_id,
          scopeId: r.scope_id,
          vertical: r.vertical,
          before: r.before === null ? null : JSON.parse(r.before),
          after: r.after === null ? null : JSON.parse(r.after),
          at: r.at,
        }) as AdminLogEntry,
    );
  }
}
