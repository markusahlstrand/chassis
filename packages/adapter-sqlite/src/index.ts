import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  adminLogEntry,
  createTenantInput,
  domainEvent,
  domainEventInput,
  eventId,
  instant,
  moduleManifest,
  objectRef,
  principalId,
  roleDefinition,
  tenant as tenantSchema,
  type AdminAction,
  type AdminLogEntry,
  type CapabilityGrant,
  type CreateTenantInput,
  type DomainEvent,
  type DomainEventInput,
  type EntityRef,
  type Node,
  type PermissionKey,
  type PlatformActorId,
  type PrincipalId,
  type RoleAssignment,
  type RoleDefinition,
  type ScopeId,
  type Tenant,
  type TenantId,
  type TenantStatus,
} from '@substrat-run/contracts';
import {
  ulid,
  type ConsumerHandler,
  type GuardPredicate,
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
} from '@substrat-run/kernel';
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

/** A manifest guard, bound to the module whose manifest declared it (K-17). */
interface DeclaredGuard {
  predicate: string;
  config: Record<string, unknown>;
  declaredBy: string;
}

export interface SqliteScopeHostOptions {
  /** Directory holding one SQLite file per scope plus the directory database. */
  dir: string;
  /** Defaults to the built-in tuple checker (deny-by-default on empty tuples). */
  checker?: PermissionChecker;
}

const KERNEL_DDL = `
  CREATE TABLE IF NOT EXISTS _substrat_outbox (
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
  CREATE TABLE IF NOT EXISTS _substrat_migrations (
    module_id TEXT NOT NULL,
    version TEXT NOT NULL,
    applied_at TEXT NOT NULL,
    PRIMARY KEY (module_id, version)
  );
  CREATE TABLE IF NOT EXISTS _substrat_tuples (
    subject TEXT NOT NULL,
    relation TEXT NOT NULL,
    object TEXT NOT NULL,
    expires_at TEXT,
    PRIMARY KEY (subject, relation, object)
  );
  CREATE TABLE IF NOT EXISTS _substrat_deliveries (
    event_id TEXT NOT NULL,
    consumer_module TEXT NOT NULL,
    delivered_at TEXT NOT NULL,
    error TEXT,
    PRIMARY KEY (event_id, consumer_module)
  );
`;

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
  /** operation name → guards declared before it, in registration order (K-17). */
  private readonly guards = new Map<string, DeclaredGuard[]>();
  /** predicate name → the module-contributed implementation. Names are global. */
  private readonly predicates = new Map<string, { module: string; handler: GuardPredicate }>();
  /** operation names whose default binding some manifest withdrew (K-17). */
  private readonly withdrawn = new Map<string, string>(); // operation → withdrawing module
  private readonly relations = new Map<string, Set<string>>();
  private readonly roles = new Map<string, RoleDefinition>(); // 'tenantId/roleKey'
  private readonly systemPrincipal: PrincipalId = principalId.parse(ulid());

  constructor(options: SqliteScopeHostOptions) {
    this.dir = options.dir;
    mkdirSync(this.dir, { recursive: true });
    this.directory = new Database(join(this.dir, '_directory.sqlite'));
    this.directory.pragma('journal_mode = WAL');
    this.directory.exec(`
      -- The tenant registry (control-plane.md §4.1). Before this a tenant was an
      -- FK string on scope rows; now it is a real record with a lifecycle status.
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
      -- Append-only control-plane audit trail (control-plane.md §4.4). Lives in
      -- the directory, not a scope DB: it records cross-tenant staff actions and
      -- is stamped host-side. Never UPDATEd, never DELETEd.
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
    // Guards (K-17): the manifest half is DECLARATION, the registration half is
    // the named predicate. They are deliberately resolved LATE — at invoke, not
    // here. Registration order is caller-controlled (a vertical may register
    // before the engine whose predicate it wires), so a fast-fail here would be
    // a lie: it would reject wiring that is merely early. The honest fail-closed
    // point is the invoke path — an unresolvable predicate BLOCKS the guarded
    // operation rather than silently letting it through, so a typo can never
    // widen the gate. What we DO enforce eagerly is the half we can see whole:
    // predicate names are global and may not collide.
    for (const [name, handler] of Object.entries(registration.predicates ?? {})) {
      const existing = this.predicates.get(name);
      if (existing) {
        throw new Error(
          `guard predicate already contributed by ${existing.module}: ${name} (names are global)`,
        );
      }
      this.predicates.set(name, { module: manifest.id, handler });
    }
    for (const guard of manifest.guards ?? []) {
      const forOperation = this.guards.get(guard.before) ?? [];
      forOperation.push({
        predicate: guard.predicate,
        config: guard.config,
        declaredBy: manifest.id,
      });
      this.guards.set(guard.before, forOperation);
    }
    this.modules.set(manifest.id, { id: manifest.id, migrations, consumers });
    for (const rel of manifest.entityRelations ?? []) {
      const parents = this.relations.get(rel.entityType) ?? new Set<string>();
      parents.add(rel.parentType);
      this.relations.set(rel.entityType, parents);
    }
    // WITHDRAWAL (K-17): suppress another module's default binding. Order
    // independent — a manifest may withdraw an operation whose module has not
    // registered yet (recorded here, skipped at defineOperation) or one already
    // registered (removed from the map now). The name then behaves exactly like
    // an unregistered one: invoke → 'unknown operation', i.e. fail closed. The
    // engine's in-scope FUNCTION is untouched — withdrawal removes the binding,
    // not the capability, which is how a vertical re-offers the same transition
    // behind its own guarded operation.
    const ownOperations = new Set(Object.keys(registration.operations ?? {}));
    for (const name of manifest.withdraws ?? []) {
      if (ownOperations.has(name)) {
        throw new Error(
          `${manifest.id} withdraws its own operation: ${name} (a module cannot withdraw itself — just don't register it)`,
        );
      }
      this.withdrawn.set(name, manifest.id);
      this.operations.delete(name);
    }
    for (const [name, handler] of Object.entries(registration.operations ?? {})) {
      this.defineOperation(name, handler);
    }
  }

  defineOperation<I, O>(name: string, handler: OperationHandler<I, O>): void {
    if (this.withdrawn.has(name)) return; // withdrawn by another manifest — never binds
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

    // Tenant-status gate (control-plane.md §4.1): a suspended (or deleting)
    // tenant fails closed for every scope under it — the same fail-closed path
    // as the K-3 pair mismatch above. A scope provisioned without a tenant
    // record (legacy path) is not gated: no record, no suspension to enforce.
    const tenantRow = this.directory
      .prepare('SELECT status FROM tenants WHERE tenant_id = ?')
      .get(tenantId) as { status: string } | undefined;
    if (tenantRow && tenantRow.status !== 'active') {
      throw new Error(`tenant not active (status: ${tenantRow.status}): ${tenantId}`);
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
            // Manifest guards (K-17): pre-conditions, inside the operation's own
            // transaction, before the handler. A throw here blocks the operation
            // and rolls back exactly like a handler throw — fail closed.
            await this.runGuards(operation, ctx, clonedInput);
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

  // -------------------------------------------------------------------------
  // Manifest-declared operation guards (K-17; engine-protocol.md §6, kernel-
  // design open question 11). Guards are keyed on OPERATIONS, never on engine
  // transitions: the kernel sees operations and must not learn engine
  // internals. They are UNCONDITIONAL gates — policy that depends on vertical
  // data stays vertical-composed glue inside the operation handler.
  // -------------------------------------------------------------------------

  private async runGuards(
    operation: string,
    ctx: OperationContext,
    input: unknown,
  ): Promise<void> {
    const declared = this.guards.get(operation);
    if (!declared) return;
    for (const guard of declared) {
      const predicate = this.predicates.get(guard.predicate);
      if (!predicate) {
        // Fail closed: a guard whose predicate cannot be resolved blocks the
        // operation. A dropped/misspelled predicate can never widen a gate.
        throw new Error(
          `unknown guard predicate: '${guard.predicate}' — declared by ${guard.declaredBy} ` +
            `before '${operation}'; no registered module contributes it (operation blocked)`,
        );
      }
      await predicate.handler(ctx, guard.config, input);
    }
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
              `SELECT * FROM _substrat_outbox o
               WHERE o.type = ?
                 AND NOT EXISTS (
                   SELECT 1 FROM _substrat_deliveries d
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
                  `INSERT INTO _substrat_deliveries (event_id, consumer_module, delivered_at)
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
                  `INSERT INTO _substrat_deliveries (event_id, consumer_module, delivered_at, error)
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
    // Every mutation below stamps one append-only row: who acted, on what, and
    // the applied payload (control-plane.md §4.4). `before` is captured only
    // where cheaply readable (a redefined role); tuple writes are idempotent
    // upserts with no cheap prior state, so their `before` is null.
    const writeAudit = (
      actor: PlatformActorId,
      action: AdminAction,
      target: { tenantId: TenantId; scopeId?: ScopeId | null; vertical?: string | null },
      before: unknown,
      after: unknown,
    ) => {
      this.directory
        .prepare(
          `INSERT INTO _substrat_admin_log
             (id, actor, action, tenant_id, scope_id, vertical, before, after, at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          ulid(),
          actor,
          action,
          target.tenantId,
          target.scopeId ?? null,
          target.vertical ?? null,
          before == null ? null : JSON.stringify(before),
          after == null ? null : JSON.stringify(after),
          new Date().toISOString(),
        );
    };

    const mapTenant = (r: TenantRow): Tenant =>
      tenantSchema.parse({
        id: r.tenant_id,
        slug: r.slug,
        name: r.name,
        status: r.status,
        createdAt: r.created_at,
      });
    const readTenant = (id: TenantId): Tenant | undefined => {
      const r = this.directory.prepare('SELECT * FROM tenants WHERE tenant_id = ?').get(id) as
        | TenantRow
        | undefined;
      return r ? mapTenant(r) : undefined;
    };

    const writeTenantTuple = (
      tenantId: string,
      subject: string,
      relation: string,
      object: string,
      expiresAt?: string,
    ) =>
      this.directory
        .prepare(
          `INSERT OR REPLACE INTO _substrat_tenant_tuples
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
          `INSERT OR REPLACE INTO _substrat_tuples (subject, relation, object, expires_at)
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
      defineRole: (actor: PlatformActorId, tenantId: TenantId, role: RoleDefinition) => {
        const parsed = roleDefinition.parse(role);
        const before = this.roles.get(`${tenantId}/${parsed.key}`) ?? null;
        this.directory
          .prepare(
            `INSERT OR REPLACE INTO _substrat_roles (tenant_id, role_key, permissions, source)
             VALUES (?, ?, ?, ?)`,
          )
          .run(tenantId, parsed.key, JSON.stringify(parsed.permissions), String(parsed.source));
        this.roles.set(`${tenantId}/${parsed.key}`, parsed);
        writeAudit(actor, 'defineRole', { tenantId }, before, parsed);
      },
      assignRole: (actor: PlatformActorId, assignment: RoleAssignment) => {
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
        writeAudit(
          actor,
          'assignRole',
          { tenantId: assignment.node.tenantId, scopeId: assignment.node.scopeId },
          null,
          assignment,
        );
      },
      grant: (actor: PlatformActorId, grant: CapabilityGrant) => {
        writeGrant(
          `principal:${grant.principalId}`,
          grant.permission,
          grant.node,
          grant.entity,
          grant.expiresAt,
        );
        writeAudit(
          actor,
          'grant',
          { tenantId: grant.node.tenantId, scopeId: grant.node.scopeId },
          null,
          grant,
        );
      },
      grantToOrg: (actor, orgId, permission, node, entity) => {
        writeGrant(`org:${orgId}`, permission, node, entity);
        writeAudit(
          actor,
          'grantToOrg',
          { tenantId: node.tenantId, scopeId: node.scopeId },
          null,
          { orgId, permission, node, entity },
        );
      },
      addMember: (actor, tenantId, principal, orgId) => {
        writeTenantTuple(tenantId, `principal:${principal}`, 'member', `org:${orgId}`);
        writeAudit(actor, 'addMember', { tenantId }, null, { principal, orgId });
      },
      createTenant: (actor: PlatformActorId, input: CreateTenantInput) => {
        const parsed = createTenantInput.parse(input);
        const info = this.directory
          .prepare(
            `INSERT OR IGNORE INTO tenants (tenant_id, slug, name, status, created_at)
             VALUES (?, ?, ?, 'active', ?)`,
          )
          .run(parsed.id, parsed.slug, parsed.name, new Date().toISOString());
        // Idempotent: re-creating an existing tenant is a no-op, and a no-op is
        // not audited — nothing changed.
        if (info.changes === 0) return;
        writeAudit(actor, 'createTenant', { tenantId: parsed.id }, null, readTenant(parsed.id));
      },
      setTenantStatus: (actor: PlatformActorId, tenantId: TenantId, status: TenantStatus) => {
        const before = readTenant(tenantId);
        if (!before) throw new Error(`unknown tenant: ${tenantId}`);
        this.directory
          .prepare('UPDATE tenants SET status = ? WHERE tenant_id = ?')
          .run(status, tenantId);
        writeAudit(
          actor,
          'setTenantStatus',
          { tenantId },
          { status: before.status },
          { status },
        );
      },
      listTenants: (): Tenant[] =>
        (this.directory.prepare('SELECT * FROM tenants ORDER BY tenant_id').all() as TenantRow[]).map(
          mapTenant,
        ),
      getTenant: (tenantId: TenantId): Tenant | undefined => readTenant(tenantId),
      auditLog: (filter?: { tenantId?: TenantId }): AdminLogEntry[] => {
        const rows = (
          filter?.tenantId
            ? this.directory
                .prepare('SELECT * FROM _substrat_admin_log WHERE tenant_id = ? ORDER BY id')
                .all(filter.tenantId)
            : this.directory.prepare('SELECT * FROM _substrat_admin_log ORDER BY id').all()
        ) as AdminLogRow[];
        return rows.map((r) =>
          adminLogEntry.parse({
            id: r.id,
            actor: r.actor,
            action: r.action,
            tenantId: r.tenant_id,
            scopeId: r.scope_id,
            vertical: r.vertical,
            before: r.before === null ? null : JSON.parse(r.before),
            after: r.after === null ? null : JSON.parse(r.after),
            at: r.at,
          }),
        );
      },
    };
  }

  private loadRoles(): void {
    const rows = this.directory
      .prepare('SELECT tenant_id, role_key, permissions, source FROM _substrat_roles')
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
            `INSERT INTO _substrat_outbox
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
            `INSERT OR IGNORE INTO _substrat_tuples (subject, relation, object)
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
            .prepare('SELECT 1 FROM _substrat_migrations WHERE module_id = ? AND version = ?')
            .get(moduleId, migration.version);
          if (!already) {
            rt.db.exec(migration.sql);
            rt.db
              .prepare(
                'INSERT INTO _substrat_migrations (module_id, version, applied_at) VALUES (?, ?, ?)',
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
        db.prepare('SELECT module_id, version FROM _substrat_migrations').all() as {
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
