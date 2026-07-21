import { DurableObject } from 'cloudflare:workers';
import {
  domainEvent,
  domainEventInput,
  eventId,
  instant,
  objectRef,
  principalId,
  type DomainEvent,
  type DomainEventInput,
  type EntityRef,
  type PermissionKey,
  type PrincipalId,
  type ScopeId,
  type TenantId,
} from '@substrat-run/contracts';
import {
  ulid,
  type ConsumerHandler,
  type GuardPredicate,
  type ModuleRegistration,
  type OperationContext,
  type OperationHandler,
  type PermissionChecker,
  type SqlMigration,
} from '@substrat-run/kernel';
import { OperationQueue } from './serialization.js';
import { doScopedSql } from './sql.js';
import { createDoTupleChecker, type ControlPlaneReader } from './checker.js';

/**
 * `defineScopeDO` — one Durable Object per scope, the CF analogue of a single
 * `SqliteScopeHost` scope runtime (D-14). It closes over a CODE-TIME module set
 * (a DO cannot receive handler closures over RPC), builds the kernel spine in
 * its own SQLite, and runs each operation inside `ctx.storage.transaction` — the
 * async transaction API that commits on success and rolls back on a throw even
 * across an `await` (verified in workerd), the direct analogue of the pure
 * adapter's `BEGIN IMMEDIATE … COMMIT/ROLLBACK`.
 *
 * The coordinator (`CloudflareScopeHost`) owns the directory, the entitlement
 * gate, and audit; the DO owns per-scope execution: migrations, guards,
 * handlers, emits, the outbox→consumer dispatch loop, entity links, and local
 * permission evaluation (scope tuples here, tenant tuples via ControlPlaneDO).
 */

export interface ScopeDoEnv {
  CONTROL_PLANE: DurableObjectNamespace;
}

interface RegisteredModule {
  id: string;
  migrations: SqlMigration[];
  consumers: { eventType: string; handler: ConsumerHandler }[];
}

interface DeclaredGuard {
  predicate: string;
  config: Record<string, unknown>;
  declaredBy: string;
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
    -- K-21: revocation tombstones rather than deletes -- the row stays, the walk
    -- skips it, and it remains readable as evidence.
    revoked_at TEXT,
    PRIMARY KEY (subject, relation, object)
  );
  CREATE TABLE IF NOT EXISTS _substrat_deliveries (
    event_id TEXT NOT NULL,
    consumer_module TEXT NOT NULL,
    -- Terminal row: when it was delivered (or dead-lettered). Retrying row: when
    -- it was last ATTEMPTED. The column predates retry state (#100) and is NOT
    -- NULL, so it carries both readings rather than forcing a rebuild.
    delivered_at TEXT NOT NULL,
    error TEXT,
    -- Retry state, executors only (#100). Consumers leave the defaults.
    --   next_attempt_at IS NOT NULL  -> pending, due at that time
    --   next_attempt_at IS NULL      -> terminal: error IS NULL delivered, else dead
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT,
    PRIMARY KEY (event_id, consumer_module)
  );
`;

/**
 * Workers RPC carries only a plain `Error`'s message/name/stack faithfully; a
 * custom subclass (e.g. Zod's `ZodError`, whose `message` is a getter over its
 * issues) arrives on the coordinator side as just its class name. Contract
 * matchers assert on the message (`/subjectId/`, `/boom/`, …), so re-wrap any
 * non-plain error as a plain `Error` before it crosses the boundary — the
 * message (which for a ZodError includes the failing path/detail) survives.
 */
function toRpcError(err: unknown): Error {
  if (err instanceof Error) {
    return err.constructor === Error ? err : new Error(err.message);
  }
  return new Error(String(err));
}

/**
 * Split a migration into its statements, honouring SQL syntax.
 *
 * The DO's `SqlStorage.exec` runs one statement per call, so a migration blob is
 * split on `;`. A naive `sql.split(';')` breaks the moment a `;` appears inside a
 * `--`/`/* *​/` comment or a string literal — it truncates the statement and the DO
 * reports "incomplete input". The SQLite adapter never hit this because
 * better-sqlite3's `exec` takes the whole blob; this is what made a migration that
 * passed on SQLite fail only on Durable Objects (the divergence this fix closes).
 *
 * So this is a small SQL-aware scanner: it skips line and block comments, copies
 * string literals through verbatim (including the `''` escape), and splits only on
 * a top-level `;`. Comments are dropped from the emitted statements — which also
 * means a trailing comment can never become a comment-only "statement" that
 * `exec` rejects. Blank fragments are skipped.
 */
export function splitSqlStatements(sql: string): string[] {
  const out: string[] = [];
  let cur = '';
  const n = sql.length;
  let i = 0;
  while (i < n) {
    const c = sql[i];
    const c2 = sql[i + 1];
    if (c === '-' && c2 === '-') {
      while (i < n && sql[i] !== '\n') i += 1; // line comment → end of line
      continue;
    }
    if (c === '/' && c2 === '*') {
      i += 2;
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i += 1;
      i += 2; // block comment → past the closing */
      continue;
    }
    if (c === "'") {
      cur += c;
      i += 1;
      while (i < n) {
        cur += sql[i];
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            cur += sql[i + 1]; // '' is an escaped quote, still inside the string
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (c === ';') {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      i += 1;
      continue;
    }
    cur += c;
    i += 1;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export function defineScopeDO(
  modules: ModuleRegistration[],
  bareOps: Record<string, OperationHandler<never, unknown>>,
): new (ctx: DurableObjectState, env: ScopeDoEnv) => DurableObject {
  return class ScopeDO extends DurableObject<ScopeDoEnv> {
    private readonly sql: SqlStorage;
    private readonly queue = new OperationQueue();
    private readonly operations = new Map<string, OperationHandler<never, unknown>>();
    private readonly modules = new Map<string, RegisteredModule>();
    private readonly guards = new Map<string, DeclaredGuard[]>();
    private readonly predicates = new Map<string, { module: string; handler: GuardPredicate }>();
    private readonly withdrawn = new Map<string, string>();
    private readonly relations = new Map<string, Set<string>>();
    private readonly checker: PermissionChecker;
    private readonly systemPrincipal: PrincipalId = principalId.parse(ulid());
    private readonly applied = new Set<string>();
    private migrationPromise?: Promise<boolean>;
    /** Latch: the applied count is reported to the directory once per DO instance. */
    private schemaVersionReported = false;
    /** The migration that failed on this instance, read back by `migrationFailure`. */
    private lastFailure: { version: string; error: string } | null = null;

    constructor(ctx: DurableObjectState, env: ScopeDoEnv) {
      super(ctx, env);
      this.sql = ctx.storage.sql;
      for (const stmt of KERNEL_DDL.split(';')) {
        const s = stmt.trim();
        if (s) this.sql.exec(s);
      }
      // KERNEL_DDL is all IF NOT EXISTS, so a scope DO created before K-21 keeps
      // the old shape. Attempt-and-tolerate: DO SQLite restricts PRAGMA, so there
      // is no column probe, and a duplicate is the steady state after the first
      // cold start (same argument as ControlPlaneDO.addColumn).
      for (const alter of [
        'ALTER TABLE _substrat_tuples ADD COLUMN revoked_at TEXT',
        // Executor retry state (#100). The defaults read as "terminal", which is
        // right for every row already there: each is a completed delivery or a
        // consumer dead-letter.
        'ALTER TABLE _substrat_deliveries ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0',
        'ALTER TABLE _substrat_deliveries ADD COLUMN next_attempt_at TEXT',
      ]) {
        try {
          this.sql.exec(alter);
        } catch (err) {
          if (!/duplicate column name/i.test((err as Error).message)) throw err;
        }
      }

      for (const registration of modules) this.registerModule(registration);
      for (const [name, handler] of Object.entries(bareOps)) this.defineOperation(name, handler);

      // Which migrations have already run (a warm DO wakes with rows here).
      for (const row of this.sql
        .exec('SELECT module_id, version FROM _substrat_migrations')
        .toArray() as unknown as { module_id: string; version: string }[]) {
        this.applied.add(`${row.module_id}@${row.version}`);
      }

      const controlPlane = this.controlPlaneReader();
      this.checker = createDoTupleChecker({ scopeSql: this.sql, controlPlane });
    }

    // -- module registration (port of SqliteScopeHost.registerModule) ---------

    private registerModule(registration: ModuleRegistration): void {
      const manifest = registration.manifest;
      this.modules.set(manifest.id, {
        id: manifest.id,
        migrations: registration.migrations ?? [],
        consumers: Object.entries(registration.consumers ?? {}).map(([eventType, handler]) => ({
          eventType,
          handler,
        })),
      });
      for (const [name, handler] of Object.entries(registration.predicates ?? {})) {
        this.predicates.set(name, { module: manifest.id, handler });
      }
      for (const guard of manifest.guards ?? []) {
        const forOperation = this.guards.get(guard.before) ?? [];
        forOperation.push({ predicate: guard.predicate, config: guard.config, declaredBy: manifest.id });
        this.guards.set(guard.before, forOperation);
      }
      for (const rel of manifest.entityRelations ?? []) {
        const parents = this.relations.get(rel.entityType) ?? new Set<string>();
        parents.add(rel.parentType);
        this.relations.set(rel.entityType, parents);
      }
      for (const name of manifest.withdraws ?? []) {
        this.withdrawn.set(name, manifest.id);
        this.operations.delete(name);
      }
      for (const [name, handler] of Object.entries(registration.operations ?? {})) {
        this.defineOperation(name, handler);
      }
    }

    private defineOperation(name: string, handler: OperationHandler<never, unknown>): void {
      if (this.withdrawn.has(name)) return; // withdrawn by another manifest — never binds
      this.operations.set(name, handler);
    }

    // -- RPC surface ----------------------------------------------------------

    /**
     * Trigger lazy migration (the coordinator calls this at provision time).
     * Returns the applied-migration count if this call applied any, else null —
     * the coordinator projects the count into the directory's `schema_version`
     * and skips the write when nothing changed.
     *
     * `ensureMigrations` memoises its promise, so every later call on a warm DO
     * resolves to the SAME `true` without applying anything. Reporting on each of
     * those would bill a control-plane RPC per stub mint to store a number that
     * has not moved — hence the once-per-instance latch.
     */
    async migrate(): Promise<number | null> {
      const applied = await this.ensureMigrations();
      if (!applied || this.schemaVersionReported) return null;
      this.schemaVersionReported = true;
      return this.applied.size;
    }

    /**
     * The last failed migration attempt on this instance, with the count that did
     * land before it. The coordinator reads this on `migrate()`'s rejection path to
     * record what failed (#32) — an extra RPC only when a scope is already broken.
     *
     * Instance state, not storage: `ensureMigrations` memoises its promise, so a
     * failed instance keeps returning the same rejection and this stays in step
     * with it. A restarted DO re-attempts and repopulates.
     */
    migrationFailure(): { version: string; error: string; applied: number } | null {
      return this.lastFailure ? { ...this.lastFailure, applied: this.applied.size } : null;
    }

    /** Admin scope-tuple write (role assignment / grant scoped to this scope). */
    async writeTuple(
      subject: string,
      relation: string,
      object: string,
      expiresAt: string | null,
    ): Promise<void> {
      await this.queue.enqueue(() => {
        this.sql.exec(
          `INSERT OR REPLACE INTO _substrat_tuples (subject, relation, object, expires_at)
           VALUES (?, ?, ?, ?)`,
          subject,
          relation,
          object,
          expiresAt,
        );
      });
    }

    async invoke(
      operation: string,
      input: unknown,
      principal: PrincipalId,
      tenantId: TenantId,
      scopeId: ScopeId,
      /**
       * Set when the caller is a CONNECTION rather than a person (#97). The
       * coordinator has already checked that the connection is live and matches
       * this scope's tenant and vertical; the DO uses it for the permission
       * subject and the event actor, so those two can never disagree.
       */
      connectionId?: string,
    ): Promise<unknown> {
      await this.ensureMigrations();
      const handler = this.operations.get(operation);
      if (!handler) throw new Error(`unknown operation: ${operation}`);
      return this.queue.enqueue(async () => {
        let result: unknown;
        // The async transaction is the K-4 boundary: guards + handler + emits
        // commit together, or a throw (from either) rolls domain writes AND
        // emitted events back as one — verified across `await` in workerd.
        try {
          await this.ctx.storage.transaction(async () => {
            const ctx = this.operationContext(
              principal,
              tenantId,
              scopeId,
              undefined,
              connectionId,
            );
            await this.runGuards(operation, ctx, input);
            result = await (handler as OperationHandler<unknown, unknown>)(ctx, input);
          });
        } catch (err) {
          throw toRpcError(err);
        }
        // Post-commit: drain the outbox to consumers, each delivery its own txn.
        await this.dispatch(tenantId, scopeId);
        return result;
      });
    }

    // -- guards (K-17) --------------------------------------------------------

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
          throw new Error(
            `unknown guard predicate: '${guard.predicate}' — declared by ${guard.declaredBy} ` +
              `before '${operation}'; no registered module contributes it (operation blocked)`,
          );
        }
        await predicate.handler(ctx, guard.config, input);
      }
    }

    // -- migrations (port of applyPendingMigrations) --------------------------

    private ensureMigrations(): Promise<boolean> {
      if (!this.migrationPromise) this.migrationPromise = this.applyPendingMigrations();
      return this.migrationPromise;
    }

    /** Resolves true if this call applied at least one migration. */
    private async applyPendingMigrations(): Promise<boolean> {
      const pending: { moduleId: string; migration: SqlMigration }[] = [];
      for (const mod of this.modules.values()) {
        for (const migration of mod.migrations) {
          if (!this.applied.has(`${mod.id}@${migration.version}`)) {
            pending.push({ moduleId: mod.id, migration });
          }
        }
      }
      if (pending.length === 0) return false;
      await this.queue.enqueue(async () => {
        for (const { moduleId, migration } of pending) {
          const key = `${moduleId}@${migration.version}`;
          if (this.applied.has(key)) continue;
          try {
            await this.ctx.storage.transaction(async () => {
              const already = this.sql
                .exec(
                  'SELECT 1 FROM _substrat_migrations WHERE module_id = ? AND version = ?',
                  moduleId,
                  migration.version,
                )
                .toArray()[0];
              if (!already) {
                for (const stmt of splitSqlStatements(migration.sql)) {
                  this.sql.exec(stmt);
                }
                this.sql.exec(
                  'INSERT INTO _substrat_migrations (module_id, version, applied_at) VALUES (?, ?, ?)',
                  moduleId,
                  migration.version,
                  new Date().toISOString(),
                );
              }
            });
          } catch (err) {
            // Retained so the coordinator can project it into the directory without
            // re-parsing the thrown message. The throw stays: `invoke` awaits
            // `ensureMigrations` on every operation and relies on the rejection to
            // fail closed, so resolving here would serve a half-migrated schema.
            this.lastFailure = { version: key, error: (err as Error).message };
            throw new Error(
              `migration failed for ${key} — scope fails closed: ${(err as Error).message}`,
            );
          }
          this.applied.add(key);
        }
      });
      return true;
    }

    /**
     * Events of `eventType` this delivery target has not yet consumed (K-22 §4.2).
     *
     * Executors run on the COORDINATOR, not here: they act through `HostAdmin`,
     * which is outside this DO. So the drain is a read here, the effect happens
     * there, and `recordExecutorAttempt` journals it afterwards — claiming before
     * running would make delivery at-most-once and lose an effect on any crash in
     * between.
     *
     * "Not yet consumed" means never attempted, or retrying and now due (#100).
     * Terminal rows — delivered or dead-lettered — are excluded by the join.
     */
    pendingExecutorEvents(deliveryId: string, eventType: string): DomainEvent[] {
      const rows = this.sql
        .exec(
          `SELECT o.* FROM _substrat_outbox o
           LEFT JOIN _substrat_deliveries d
             ON d.event_id = o.id AND d.consumer_module = ?
           WHERE o.type = ?
             AND (d.event_id IS NULL
                  OR (d.next_attempt_at IS NOT NULL AND d.next_attempt_at <= ?))
           ORDER BY o.id`,
          deliveryId,
          eventType,
          new Date().toISOString(),
        )
        .toArray() as unknown as OutboxRow[];
      return rows.map((r) => this.parseOutboxRow(r));
    }

    /**
     * Journal one executor attempt (#100). `error` null means delivered;
     * `nextAttemptAt` null means terminal — so a failed attempt with no next time
     * is a dead letter.
     *
     * Written AFTER the effect, so a crash mid-effect retries rather than silently
     * marking success. The coordinator computes the backoff because it owns the
     * per-executor policy; the DO owns the state.
     */
    recordExecutorAttempt(
      eventId: string,
      deliveryId: string,
      error: string | null,
      nextAttemptAt: string | null,
    ): number {
      const prior = (
        this.sql
          .exec(
            'SELECT attempts FROM _substrat_deliveries WHERE event_id = ? AND consumer_module = ?',
            eventId,
            deliveryId,
          )
          .toArray() as unknown as { attempts: number }[]
      )[0];
      const attempts = (prior?.attempts ?? 0) + 1;
      this.sql.exec(
        `INSERT INTO _substrat_deliveries
           (event_id, consumer_module, delivered_at, error, attempts, next_attempt_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (event_id, consumer_module) DO UPDATE SET
           delivered_at = excluded.delivered_at,
           error = excluded.error,
           attempts = excluded.attempts,
           next_attempt_at = excluded.next_attempt_at`,
        eventId,
        deliveryId,
        new Date().toISOString(),
        error,
        attempts,
        nextAttemptAt,
      );
      return attempts;
    }

    /** How many attempts this delivery has already had — the backoff input. */
    executorAttempts(eventId: string, deliveryId: string): number {
      const row = (
        this.sql
          .exec(
            'SELECT attempts FROM _substrat_deliveries WHERE event_id = ? AND consumer_module = ?',
            eventId,
            deliveryId,
          )
          .toArray() as unknown as { attempts: number }[]
      )[0];
      return row?.attempts ?? 0;
    }

    /** Executor deliveries that exhausted their attempts. */
    executorDeadLetters(): {
      eventId: string;
      executorId: string;
      eventType: string;
      attempts: number;
      error: string;
      lastAttemptAt: string;
    }[] {
      const rows = this.sql
        .exec(
          `SELECT d.event_id, d.consumer_module, d.attempts, d.error, d.delivered_at, o.type
           FROM _substrat_deliveries d
           JOIN _substrat_outbox o ON o.id = d.event_id
           WHERE d.consumer_module LIKE 'executor:%'
             AND d.error IS NOT NULL
             AND d.next_attempt_at IS NULL
           ORDER BY d.event_id`,
        )
        .toArray() as unknown as {
        event_id: string;
        consumer_module: string;
        attempts: number;
        error: string;
        delivered_at: string;
        type: string;
      }[];
      return rows.map((r) => ({
        eventId: r.event_id,
        executorId: r.consumer_module.slice('executor:'.length),
        eventType: r.type,
        attempts: r.attempts,
        error: r.error,
        lastAttemptAt: r.delivered_at,
      }));
    }

    // -- event dispatch (port of dispatch) ------------------------------------

    private async dispatch(tenantId: TenantId, scopeId: ScopeId): Promise<void> {
      for (let round = 0; round < 50; round++) {
        let deliveredAny = false;
        for (const mod of this.modules.values()) {
          for (const consumer of mod.consumers) {
            const rows = this.sql
              .exec(
                `SELECT * FROM _substrat_outbox o
                 WHERE o.type = ?
                   AND NOT EXISTS (
                     SELECT 1 FROM _substrat_deliveries d
                     WHERE d.event_id = o.id AND d.consumer_module = ?
                   )
                 ORDER BY o.id`,
                consumer.eventType,
                mod.id,
              )
              .toArray() as unknown as OutboxRow[];
            for (const row of rows) {
              const event = this.parseOutboxRow(row);
              try {
                await this.ctx.storage.transaction(async () => {
                  const ctx = this.operationContext(this.systemPrincipal, tenantId, scopeId, {
                    system: mod.id,
                  });
                  await consumer.handler(ctx, event);
                  this.sql.exec(
                    `INSERT INTO _substrat_deliveries (event_id, consumer_module, delivered_at)
                     VALUES (?, ?, ?)`,
                    event.id,
                    mod.id,
                    new Date().toISOString(),
                  );
                });
                deliveredAny = true;
              } catch (err) {
                // Dead-letter (v0): journal the failure so one poison event
                // can't wedge the loop. Written outside the rolled-back txn.
                this.sql.exec(
                  `INSERT INTO _substrat_deliveries (event_id, consumer_module, delivered_at, error)
                   VALUES (?, ?, ?, ?)`,
                  event.id,
                  mod.id,
                  new Date().toISOString(),
                  String(err),
                );
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

    // -- operation context (port of operationContext) -------------------------

    private operationContext(
      principal: PrincipalId,
      tenantId: TenantId,
      scopeId: ScopeId,
      systemActor?: { system: string },
      connectionId?: string,
    ): OperationContext {
      const checker = this.checker;
      const relations = this.relations;
      const sql = this.sql;
      return {
        tenantId,
        scopeId,
        principal,
        sql: doScopedSql(sql),
        emit: (event: DomainEventInput) => {
          const parsed = domainEventInput.parse(event);
          const full = domainEvent.parse({
            ...parsed,
            id: eventId.parse(ulid()),
            occurredAt: instant.parse(new Date().toISOString()),
            tenantId,
            scopeId,
            actor: systemActor ?? (connectionId ? { connection: connectionId } : principal),
          });
          sql.exec(
            `INSERT INTO _substrat_outbox
               (id, type, schema_version, occurred_at, tenant_id, scope_id, actor,
                entity_type, entity_id, pii_class, subject_id, payload)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        check: (permission: PermissionKey, entity?: EntityRef) =>
          systemActor
            ? Promise.resolve({
                allowed: true as const,
                proof: [
                  {
                    subject: objectRef.parse(
                      `system:${systemActor.system.replace(/[^a-zA-Z0-9_.-]/g, '-')}`,
                    ),
                    relation: `granted:${permission}`,
                    object: objectRef.parse(`scope:${scopeId}`),
                  },
                ],
              })
            : checker.check(
                connectionId
                  ? { kind: 'connection', id: connectionId }
                  : { kind: 'principal', id: principal },
                permission,
                { tenantId, scopeId },
                entity,
              ),
        link: (child: EntityRef, parent: EntityRef) => {
          const allowed = relations.get(child.entityType);
          if (!allowed?.has(parent.entityType)) {
            throw new Error(
              `undeclared entity relation: ${child.entityType} → ${parent.entityType} ` +
                `(declare it in a module manifest's entityRelations)`,
            );
          }
          sql.exec(
            `INSERT OR IGNORE INTO _substrat_tuples (subject, relation, object)
             VALUES (?, 'parent', ?)`,
            `${child.entityType}:${child.entityId}`,
            `${parent.entityType}:${parent.entityId}`,
          );
        },
      };
    }

    private controlPlaneReader(): ControlPlaneReader {
      const ns = this.env.CONTROL_PLANE;
      const stub = ns.get(ns.idFromName('control-plane')) as unknown as ControlPlaneReader;
      return {
        tenantTuples: (tenantId, subject, relationPrefix) =>
          stub.tenantTuples(tenantId, subject, relationPrefix),
        getRole: (tenantId, key) => stub.getRole(tenantId, key),
      };
    }
  };
}
