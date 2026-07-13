import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  domainEvent,
  domainEventInput,
  eventId,
  instant,
  type DomainEventInput,
  type PrincipalId,
  type ScopeId,
  type TenantId,
} from '@chassis/contracts';
import {
  denyAllChecker,
  ulid,
  type OperationContext,
  type OperationHandler,
  type PermissionChecker,
  type ProvisionScopeInput,
  type ScopedSql,
  type ScopeHost,
  type ScopeStub,
  type SqlValue,
} from '@chassis/kernel';
import { ScopeActor } from './actor.js';

interface ScopeRuntime {
  db: Database.Database;
  actor: ScopeActor;
}

export interface SqliteScopeHostOptions {
  /** Directory holding one SQLite file per scope plus the directory database. */
  dir: string;
  /** Defaults to deny-all (secure default). Tests pass UNSAFE_allowAllChecker explicitly. */
  checker?: PermissionChecker;
}

const OUTBOX_DDL = `
  CREATE TABLE IF NOT EXISTS _chassis_outbox (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    schema_version INTEGER NOT NULL,
    occurred_at TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    actor TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    pii_class TEXT NOT NULL,
    subject_id TEXT,
    payload TEXT,
    drained_at TEXT
  );
  CREATE TABLE IF NOT EXISTS _chassis_migrations (
    module_id TEXT NOT NULL,
    version TEXT NOT NULL,
    applied_at TEXT NOT NULL,
    PRIMARY KEY (module_id, version)
  );
`;

export class SqliteScopeHost implements ScopeHost {
  private readonly dir: string;
  private readonly checker: PermissionChecker;
  private readonly directory: Database.Database;
  private readonly scopes = new Map<string, ScopeRuntime>();
  private readonly operations = new Map<string, OperationHandler<never, unknown>>();

  constructor(options: SqliteScopeHostOptions) {
    this.dir = options.dir;
    this.checker = options.checker ?? denyAllChecker;
    mkdirSync(this.dir, { recursive: true });
    this.directory = new Database(join(this.dir, '_directory.sqlite'));
    this.directory.pragma('journal_mode = WAL');
    this.directory.exec(`
      CREATE TABLE IF NOT EXISTS scopes (
        scope_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        storage_shape TEXT NOT NULL DEFAULT 'A',
        jurisdiction TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        schema_version TEXT NOT NULL DEFAULT '0',
        created_at TEXT NOT NULL
      );
    `);
  }

  defineOperation<I, O>(name: string, handler: OperationHandler<I, O>): void {
    if (this.operations.has(name)) throw new Error(`operation already defined: ${name}`);
    this.operations.set(name, handler as OperationHandler<never, unknown>);
  }

  async provisionScope(input: ProvisionScopeInput): Promise<void> {
    // Idempotent: re-running after a crash between steps is safe (§3.3).
    this.directory
      .prepare(
        `INSERT OR IGNORE INTO scopes (scope_id, tenant_id, storage_shape, jurisdiction, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        input.scopeId,
        input.tenantId,
        input.storageShape ?? 'A',
        input.jurisdiction ?? null,
        new Date().toISOString(),
      );
    this.runtime(input.tenantId, input.scopeId); // creates the scope db + kernel tables
  }

  async getScope(
    principal: PrincipalId,
    tenantId: TenantId,
    scopeId: ScopeId,
  ): Promise<ScopeStub> {
    // Cross-check the pair against the directory — fail closed (K-3).
    const row = this.directory
      .prepare('SELECT tenant_id FROM scopes WHERE scope_id = ?')
      .get(scopeId) as { tenant_id: string } | undefined;
    if (!row || row.tenant_id !== tenantId) {
      throw new Error(`unknown scope for tenant: (${tenantId}, ${scopeId})`);
    }

    const { db, actor } = this.runtime(tenantId, scopeId);
    const checker = this.checker;
    const operations = this.operations;

    const ctx: OperationContext = {
      tenantId,
      scopeId,
      principal,
      sql: scopedSql(db),
      emit: (event: DomainEventInput) => {
        const input = domainEventInput.parse(event);
        // Envelope stamped kernel-side; the caller cannot mislabel origin (§6.1).
        const full = domainEvent.parse({
          ...input,
          id: eventId.parse(ulid()),
          occurredAt: instant.parse(new Date().toISOString()),
          tenantId,
          scopeId,
          actor: principal,
        });
        db.prepare(
          `INSERT INTO _chassis_outbox
             (id, type, schema_version, occurred_at, tenant_id, scope_id, actor,
              entity_type, entity_id, pii_class, subject_id, payload)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          full.id,
          full.type,
          full.schemaVersion,
          full.occurredAt,
          full.tenantId,
          full.scopeId,
          JSON.stringify(full.actor),
          full.entity.entityType,
          full.entity.entityId,
          full.piiClass,
          full.subjectId ?? null,
          full.payload === undefined ? null : JSON.stringify(full.payload),
        );
      },
      check: (permission) => checker.check(principal, permission, { tenantId, scopeId }),
    };

    return {
      tenantId,
      scopeId,
      invoke: <O, I>(operation: string, input?: I): Promise<O> => {
        const handler = operations.get(operation);
        if (!handler) return Promise.reject(new Error(`unknown operation: ${operation}`));
        return actor.enqueue(async () => {
          // Structured-clone boundary in BOTH directions (K-6): in-process must
          // not be observably different from RPC.
          const clonedInput = structuredClone(input);
          const result = await (handler as OperationHandler<I | undefined, O>)(
            ctx,
            clonedInput,
          );
          return structuredClone(result);
        });
      },
    };
  }

  async close(): Promise<void> {
    for (const { db } of this.scopes.values()) db.close();
    this.scopes.clear();
    this.directory.close();
  }

  private runtime(tenantId: TenantId, scopeId: ScopeId): ScopeRuntime {
    const key = `${tenantId}/${scopeId}`;
    const existing = this.scopes.get(key);
    if (existing) return existing;
    const db = new Database(join(this.dir, `${tenantId}__${scopeId}.sqlite`));
    db.pragma('journal_mode = WAL');
    db.exec(OUTBOX_DDL);
    const created: ScopeRuntime = { db, actor: new ScopeActor() };
    this.scopes.set(key, created);
    return created;
  }
}

function scopedSql(db: Database.Database): ScopedSql {
  return {
    query: <T>(sql: string, params: readonly SqlValue[] = []): T[] =>
      db.prepare(sql).all(...params) as T[],
    exec: (sql: string, params: readonly SqlValue[] = []) => {
      const info = db.prepare(sql).run(...params);
      return { changes: info.changes };
    },
  };
}
