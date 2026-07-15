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
  CREATE TABLE IF NOT EXISTS scopes (
    scope_id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    storage_shape TEXT NOT NULL DEFAULT 'A',
    jurisdiction TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    schema_version TEXT NOT NULL DEFAULT '0',
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
`;

export class ControlPlaneDO extends DurableObject {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    this.sql = ctx.storage.sql;
    for (const stmt of DIRECTORY_DDL.split(';')) {
      const s = stmt.trim();
      if (s) this.sql.exec(s);
    }
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

  /** INSERT OR IGNORE; return the new tenant, or null if it already existed. */
  createTenant(id: string, slug: string, name: string, createdAt: string): Tenant | null {
    if (this.readTenant(id)) return null; // idempotent — nothing created
    this.sql.exec(
      `INSERT OR IGNORE INTO tenants (tenant_id, slug, name, status, created_at)
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
    storageShape: string,
    jurisdiction: string | null,
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
    const existed =
      this.sql.exec('SELECT 1 FROM scopes WHERE scope_id = ?', scopeId).toArray()[0] !== undefined;
    if (!existed) {
      this.sql.exec(
        `INSERT OR IGNORE INTO scopes (scope_id, tenant_id, storage_shape, jurisdiction, status, created_at)
         VALUES (?, ?, ?, ?, 'active', ?)`,
        scopeId,
        tenantId,
        storageShape,
        jurisdiction,
        createdAt,
      );
    }
    return !existed;
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
   * illegal one), flip the status. Returns the previous status for the audit.
   * `action` rides along only to name the illegal-transition message.
   */
  transitionScope(
    tenantId: string,
    scopeId: string,
    from: string[],
    to: ScopeStatus,
    action: string,
  ): string {
    const row = this.sql
      .exec('SELECT tenant_id, status FROM scopes WHERE scope_id = ?', scopeId)
      .toArray()[0] as { tenant_id: string; status: string } | undefined;
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
    return row.status;
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

  auditLog(tenantId: string | null): AdminLogEntry[] {
    const rows = (
      tenantId
        ? this.sql.exec(
            'SELECT * FROM _substrat_admin_log WHERE tenant_id = ? ORDER BY id',
            tenantId,
          )
        : this.sql.exec('SELECT * FROM _substrat_admin_log ORDER BY id')
    ).toArray() as unknown as AdminLogRow[];
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
