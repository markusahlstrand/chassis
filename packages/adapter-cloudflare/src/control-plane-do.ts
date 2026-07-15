import { DurableObject } from 'cloudflare:workers';
import type { RoleDefinition } from '@substrat-run/contracts';

/**
 * The directory's cross-DO half (control-plane.md §4). One singleton DO holds
 * exactly the enforcement-input a ScopeDO's permission checker cannot reach on
 * its own — tenant-level relation tuples (role assignments, direct grants, org
 * membership) and role definitions. A ScopeDO evaluates `ctx.check` locally for
 * scope + entity tuples, then RPCs here for the tenant-level rows.
 *
 * The rest of the directory surface (tenant registry, scope lifecycle,
 * entitlements, identities, the admin audit log) is served synchronously by the
 * coordinator (`CloudflareScopeHost`) because `HostAdmin` is a synchronous
 * interface: its reads and its fail-closed throws cannot await an RPC. Those
 * live in the coordinator's in-memory directory. THIS DO owns only what a
 * different DO must be able to read — see host.ts for the split rationale.
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

const DIRECTORY_DDL = `
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

  // -- roles (checker rule 1) -------------------------------------------------

  defineRole(tenantId: string, role: RoleDefinition): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO _substrat_roles (tenant_id, role_key, permissions, source)
       VALUES (?, ?, ?, ?)`,
      tenantId,
      role.key,
      JSON.stringify(role.permissions),
      String(role.source),
    );
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
}
