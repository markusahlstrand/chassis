import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  domainEvent,
  domainEventInput,
  eventId,
  instant,
  moduleManifest,
  objectRef,
  principalId,
  roleDefinition,
  type CapabilityGrant,
  type DomainEvent,
  type DomainEventInput,
  type EntityRef,
  type Node,
  type PermissionKey,
  type PrincipalId,
  type RoleAssignment,
  type RoleDefinition,
  type ScopeId,
  type TenantId,
} from '@chassis/contracts';
import {
  ulid,
  type ConsumerHandler,
  type HostAdmin,
  type ModuleRegistration,
  type OperationContext,
  type OperationHandler,
  type PermissionChecker,
  type ProvisionScopeInput,
  type ScopedSql,
  type ScopeHost,
  type ScopeStub,
  type SqlMigration,
  type SqlValue,
} from '@chassis/kernel';
import { ScopeActor } from './actor.js';
import { createTupleChecker } from './checker.js';

interface ScopeRuntime {
  tenantId: TenantId;
  scopeId: ScopeId;
  db: Database.Database;
  actor: ScopeActor;
  appliedMigrations: Set<string>;
}

interface RegisteredModule {
  id: string;
  migrations: SqlMigration[];
  consumers: { eventType: string; handler: ConsumerHandler }[];
}

export interface SqliteScopeHostOptions {
  /** Directory holding one SQLite file per scope plus the directory database. */
  dir: string;
  /** Defaults to the built-in tuple checker (deny-by-default on empty tuples). */
  checker?: PermissionChecker;
}

const KERNEL_DDL = `
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
  CREATE TABLE IF NOT EXISTS _chassis_tuples (
    subject TEXT NOT NULL,
    relation TEXT NOT NULL,
    object TEXT NOT NULL,
    expires_at TEXT,
    PRIMARY KEY (subject, relation, object)
  );
  CREATE TABLE IF NOT EXISTS _chassis_deliveries (
    event_id TEXT NOT NULL,
    consumer_module TEXT NOT NULL,
    delivered_at TEXT NOT NULL,
    error TEXT,
    PRIMARY KEY (event_id, consumer_module)
  );
`;

interface OutboxRow {
  id: string;
  type: string;
  schema_version: number;
  occurred_at: string;
  tenant_id: string;
  scope_id: string;
  actor: string;
  entity_type: string;
  entity_id: string;
  pii_class: string;
  subject_id: string | null;
  payload: string | null;
}

export class SqliteScopeHost implements ScopeHost {
  readonly admin: HostAdmin;
  private readonly dir: string;
  private readonly checker: PermissionChecker;
  private readonly directory: Database.Database;
  private readonly scopes = new Map<string, ScopeRuntime>();
  private readonly scopesById = new Map<string, ScopeRuntime>();
  private readonly operations = new Map<string, OperationHandler<never, unknown>>();
  private readonly modules = new Map<string, RegisteredModule>();
  private readonly relations = new Map<string, Set<string>>();
  private readonly roles = new Map<string, RoleDefinition>(); // 'tenantId/roleKey'
  private readonly systemPrincipal: PrincipalId = principalId.parse(ulid());

  constructor(options: SqliteScopeHostOptions) {
    this.dir = options.dir;
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
      CREATE TABLE IF NOT EXISTS _chassis_tenant_tuples (
        tenant_id TEXT NOT NULL,
        subject TEXT NOT NULL,
        relation TEXT NOT NULL,
        object TEXT NOT NULL,
        expires_at TEXT,
        PRIMARY KEY (tenant_id, subject, relation, object)
      );
      CREATE TABLE IF NOT EXISTS _chassis_roles (
        tenant_id TEXT NOT NULL,
        role_key TEXT NOT NULL,
        permissions TEXT NOT NULL,
        source TEXT NOT NULL,
        PRIMARY KEY (tenant_id, role_key)
      );
    `);
    this.loadRoles();
    this.checker =
      options.checker ??
      createTupleChecker({
        directory: this.directory,
        scopeDb: (scopeId) => this.scopesById.get(scopeId)?.db,
        getRole: (tenantId, key) => this.roles.get(`${tenantId}/${key}`),
      });
    this.admin = this.buildAdmin();
  }

  registerModule(registration: ModuleRegistration): void {
    const manifest = moduleManifest.parse(registration.manifest);
    if (this.modules.has(manifest.id)) {
      throw new Error(`module already registered: ${manifest.id}`);
    }
    const migrations = registration.migrations ?? [];
    const seen = new Set<string>();
    for (const m of migrations) {
      if (seen.has(m.version)) {
        throw new Error(`duplicate migration version in ${manifest.id}: ${m.version}`);
      }
      seen.add(m.version);
    }
    const declaredConsumes = new Set(manifest.events.consumes.map((c) => c.type));
    const consumers = Object.entries(registration.consumers ?? {}).map(
      ([eventType, handler]) => {
        if (!declaredConsumes.has(eventType)) {
          throw new Error(
            `${manifest.id} registers a consumer for undeclared event type: ${eventType}`,
          );
        }
        return { eventType, handler };
      },
    );
    this.modules.set(manifest.id, { id: manifest.id, migrations, consumers });
    for (const rel of manifest.entityRelations ?? []) {
      const parents = this.relations.get(rel.entityType) ?? new Set<string>();
      parents.add(rel.parentType);
      this.relations.set(rel.entityType, parents);
    }
    for (const [name, handler] of Object.entries(registration.operations ?? {})) {
      this.defineOperation(name, handler);
    }
  }

  defineOperation<I, O>(name: string, handler: OperationHandler<I, O>): void {
    if (this.operations.has(name)) throw new Error(`operation already defined: ${name}`);
    this.operations.set(name, handler as OperationHandler<never, unknown>);
  }

  async provisionScope(input: ProvisionScopeInput): Promise<void> {
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
    const rt = this.runtime(input.tenantId, input.scopeId);
    await this.applyPendingMigrations(rt);
  }

  async getScope(
    principal: PrincipalId,
    tenantId: TenantId,
    scopeId: ScopeId,
  ): Promise<ScopeStub> {
    const row = this.directory
      .prepare('SELECT tenant_id FROM scopes WHERE scope_id = ?')
      .get(scopeId) as { tenant_id: string } | undefined;
    if (!row || row.tenant_id !== tenantId) {
      throw new Error(`unknown scope for tenant: (${tenantId}, ${scopeId})`);
    }

    const rt = this.runtime(tenantId, scopeId);
    await this.applyPendingMigrations(rt);
    const ctx = this.operationContext(rt, principal);
    const operations = this.operations;

    return {
      tenantId,
      scopeId,
      invoke: <O, I>(operation: string, input?: I): Promise<O> => {
        const handler = operations.get(operation);
        if (!handler) return Promise.reject(new Error(`unknown operation: ${operation}`));
        return rt.actor.enqueue(async () => {
          const clonedInput = structuredClone(input);
          rt.db.exec('BEGIN IMMEDIATE');
          let result: O;
          try {
            result = await (handler as OperationHandler<I | undefined, O>)(ctx, clonedInput);
            rt.db.exec('COMMIT');
          } catch (err) {
            rt.db.exec('ROLLBACK');
            throw err;
          }
          // Post-commit, still inside the actor task: drain outbox → consumers.
          await this.dispatch(rt);
          return structuredClone(result);
        });
      },
    };
  }

  async close(): Promise<void> {
    for (const { db } of this.scopes.values()) db.close();
    this.scopes.clear();
    this.scopesById.clear();
    this.directory.close();
  }

  // -------------------------------------------------------------------------
  // Event dispatch (testrun spec §9.2.3): at-least-once, kernel-journaled,
  // consumers run as system-actor operations in their own transactions.
  // -------------------------------------------------------------------------

  private async dispatch(rt: ScopeRuntime): Promise<void> {
    for (let round = 0; round < 50; round++) {
      let deliveredAny = false;
      for (const mod of this.modules.values()) {
        for (const consumer of mod.consumers) {
          const rows = rt.db
            .prepare(
              `SELECT * FROM _chassis_outbox o
               WHERE o.type = ?
                 AND NOT EXISTS (
                   SELECT 1 FROM _chassis_deliveries d
                   WHERE d.event_id = o.id AND d.consumer_module = ?
                 )
               ORDER BY o.id`,
            )
            .all(consumer.eventType, mod.id) as OutboxRow[];
          for (const row of rows) {
            const event = this.parseOutboxRow(row);
            const ctx = this.operationContext(rt, this.systemPrincipal, {
              system: mod.id,
            });
            rt.db.exec('BEGIN IMMEDIATE');
            try {
              await consumer.handler(ctx, event);
              rt.db
                .prepare(
                  `INSERT INTO _chassis_deliveries (event_id, consumer_module, delivered_at)
                   VALUES (?, ?, ?)`,
                )
                .run(event.id, mod.id, new Date().toISOString());
              rt.db.exec('COMMIT');
              deliveredAny = true;
            } catch (err) {
              rt.db.exec('ROLLBACK');
              // Dead-letter (v0): journal the failure so one poison event
              // can't wedge the loop. Real redelivery/backoff is a later cut.
              rt.db
                .prepare(
                  `INSERT INTO _chassis_deliveries (event_id, consumer_module, delivered_at, error)
                   VALUES (?, ?, ?, ?)`,
                )
                .run(event.id, mod.id, new Date().toISOString(), String(err));
            }
          }
        }
      }
      if (!deliveredAny) return;
    }
  }

  private parseOutboxRow(row: OutboxRow): DomainEvent {
    return domainEvent.parse({
      id: row.id,
      type: row.type,
      schemaVersion: row.schema_version,
      occurredAt: row.occurred_at,
      tenantId: row.tenant_id,
      scopeId: row.scope_id,
      actor: JSON.parse(row.actor),
      entity: { entityType: row.entity_type, entityId: row.entity_id },
      piiClass: row.pii_class,
      ...(row.subject_id ? { subjectId: row.subject_id } : {}),
      payload: row.payload === null ? undefined : JSON.parse(row.payload),
    });
  }

  // -------------------------------------------------------------------------
  // Admin surface (enforcement input, §9.2.5)
  // -------------------------------------------------------------------------

  private buildAdmin(): HostAdmin {
    const writeTenantTuple = (
      tenantId: string,
      subject: string,
      relation: string,
      object: string,
      expiresAt?: string,
    ) =>
      this.directory
        .prepare(
          `INSERT OR REPLACE INTO _chassis_tenant_tuples
             (tenant_id, subject, relation, object, expires_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(tenantId, subject, relation, object, expiresAt ?? null);

    const writeScopeTuple = (
      node: Node,
      subject: string,
      relation: string,
      object: string,
      expiresAt?: string,
    ) => {
      if (!node.scopeId) throw new Error('scope tuple requires node.scopeId');
      const rt = this.runtime(node.tenantId, node.scopeId);
      rt.db
        .prepare(
          `INSERT OR REPLACE INTO _chassis_tuples (subject, relation, object, expires_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(subject, relation, object, expiresAt ?? null);
    };

    const writeGrant = (
      subject: string,
      permission: PermissionKey,
      node: Node,
      entity?: EntityRef,
      expiresAt?: string,
    ) => {
      if (entity) {
        writeScopeTuple(
          node,
          subject,
          `granted:${permission}`,
          `${entity.entityType}:${entity.entityId}`,
          expiresAt,
        );
      } else if (node.scopeId) {
        writeScopeTuple(node, subject, `granted:${permission}`, `scope:${node.scopeId}`, expiresAt);
      } else {
        writeTenantTuple(
          node.tenantId,
          subject,
          `granted:${permission}`,
          `tenant:${node.tenantId}`,
          expiresAt,
        );
      }
    };

    return {
      defineRole: (tenantId: TenantId, role: RoleDefinition) => {
        const parsed = roleDefinition.parse(role);
        this.directory
          .prepare(
            `INSERT OR REPLACE INTO _chassis_roles (tenant_id, role_key, permissions, source)
             VALUES (?, ?, ?, ?)`,
          )
          .run(tenantId, parsed.key, JSON.stringify(parsed.permissions), String(parsed.source));
        this.roles.set(`${tenantId}/${parsed.key}`, parsed);
      },
      assignRole: (assignment: RoleAssignment) => {
        const subject = `principal:${assignment.principalId}`;
        if (assignment.node.scopeId) {
          writeScopeTuple(
            assignment.node,
            subject,
            `role:${assignment.roleKey}`,
            `scope:${assignment.node.scopeId}`,
          );
        } else {
          writeTenantTuple(
            assignment.node.tenantId,
            subject,
            `role:${assignment.roleKey}`,
            `tenant:${assignment.node.tenantId}`,
          );
        }
      },
      grant: (grant: CapabilityGrant) => {
        writeGrant(
          `principal:${grant.principalId}`,
          grant.permission,
          grant.node,
          grant.entity,
          grant.expiresAt,
        );
      },
      grantToOrg: (orgId, permission, node, entity) => {
        writeGrant(`org:${orgId}`, permission, node, entity);
      },
      addMember: (tenantId, principal, orgId) => {
        writeTenantTuple(tenantId, `principal:${principal}`, 'member', `org:${orgId}`);
      },
    };
  }

  private loadRoles(): void {
    const rows = this.directory
      .prepare('SELECT tenant_id, role_key, permissions, source FROM _chassis_roles')
      .all() as { tenant_id: string; role_key: string; permissions: string; source: string }[];
    for (const r of rows) {
      this.roles.set(`${r.tenant_id}/${r.role_key}`, {
        key: r.role_key,
        permissions: JSON.parse(r.permissions),
        source: r.source,
      } as RoleDefinition);
    }
  }

  // -------------------------------------------------------------------------

  private operationContext(
    rt: ScopeRuntime,
    principal: PrincipalId,
    systemActor?: { system: string },
  ): OperationContext {
    const checker = this.checker;
    const relations = this.relations;
    return {
      tenantId: rt.tenantId,
      scopeId: rt.scopeId,
      principal,
      sql: scopedSql(rt.db),
      emit: (event: DomainEventInput) => {
        const input = domainEventInput.parse(event);
        const full = domainEvent.parse({
          ...input,
          id: eventId.parse(ulid()),
          occurredAt: instant.parse(new Date().toISOString()),
          tenantId: rt.tenantId,
          scopeId: rt.scopeId,
          actor: systemActor ?? principal,
        });
        rt.db
          .prepare(
            `INSERT INTO _chassis_outbox
               (id, type, schema_version, occurred_at, tenant_id, scope_id, actor,
                entity_type, entity_id, pii_class, subject_id, payload)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
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
      check: (permission, entity?) =>
        systemActor
          ? Promise.resolve({
              allowed: true as const,
              proof: [
                {
                  subject: objectRef.parse(
                    `system:${systemActor.system.replace(/[^a-zA-Z0-9_.-]/g, '-')}`,
                  ),
                  relation: `granted:${permission}`,
                  object: objectRef.parse(`scope:${rt.scopeId}`),
                },
              ],
            })
          : checker.check(principal, permission, { tenantId: rt.tenantId, scopeId: rt.scopeId }, entity),
      link: (child: EntityRef, parent: EntityRef) => {
        const allowed = relations.get(child.entityType);
        if (!allowed?.has(parent.entityType)) {
          throw new Error(
            `undeclared entity relation: ${child.entityType} → ${parent.entityType} ` +
              `(declare it in a module manifest's entityRelations)`,
          );
        }
        rt.db
          .prepare(
            `INSERT OR IGNORE INTO _chassis_tuples (subject, relation, object)
             VALUES (?, 'parent', ?)`,
          )
          .run(`${child.entityType}:${child.entityId}`, `${parent.entityType}:${parent.entityId}`);
      },
    };
  }

  private applyPendingMigrations(rt: ScopeRuntime): Promise<void> {
    const pending: { moduleId: string; migration: SqlMigration }[] = [];
    for (const mod of this.modules.values()) {
      for (const migration of mod.migrations) {
        if (!rt.appliedMigrations.has(`${mod.id}@${migration.version}`)) {
          pending.push({ moduleId: mod.id, migration });
        }
      }
    }
    if (pending.length === 0) return Promise.resolve();
    return rt.actor.enqueue(() => {
      for (const { moduleId, migration } of pending) {
        const key = `${moduleId}@${migration.version}`;
        if (rt.appliedMigrations.has(key)) continue;
        rt.db.exec('BEGIN IMMEDIATE');
        try {
          const already = rt.db
            .prepare('SELECT 1 FROM _chassis_migrations WHERE module_id = ? AND version = ?')
            .get(moduleId, migration.version);
          if (!already) {
            rt.db.exec(migration.sql);
            rt.db
              .prepare(
                'INSERT INTO _chassis_migrations (module_id, version, applied_at) VALUES (?, ?, ?)',
              )
              .run(moduleId, migration.version, new Date().toISOString());
          }
          rt.db.exec('COMMIT');
        } catch (err) {
          rt.db.exec('ROLLBACK');
          throw new Error(
            `migration failed for ${key} — scope fails closed: ${(err as Error).message}`,
          );
        }
        rt.appliedMigrations.add(key);
      }
    });
  }

  private runtime(tenantId: TenantId, scopeId: ScopeId): ScopeRuntime {
    const key = `${tenantId}/${scopeId}`;
    const existing = this.scopes.get(key);
    if (existing) return existing;
    const db = new Database(join(this.dir, `${tenantId}__${scopeId}.sqlite`));
    db.pragma('journal_mode = WAL');
    db.exec(KERNEL_DDL);
    const appliedMigrations = new Set<string>(
      (
        db.prepare('SELECT module_id, version FROM _chassis_migrations').all() as {
          module_id: string;
          version: string;
        }[]
      ).map((r) => `${r.module_id}@${r.version}`),
    );
    const created: ScopeRuntime = { tenantId, scopeId, db, actor: new ScopeActor(), appliedMigrations };
    this.scopes.set(key, created);
    this.scopesById.set(scopeId, created);
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
