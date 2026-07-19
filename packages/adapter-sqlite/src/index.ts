import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  adminLogEntry,
  createTenantInput,
  domainEvent,
  domainEventInput,
  eventId,
  identityLink,
  identityPool,
  instant,
  moduleManifest,
  createOrgInput,
  objectRef,
  org as orgSchema,
  orgMembership,
  principalId,
  resolvedIdentity,
  roleDefinition,
  scope as scopeSchema,
  tenant as tenantSchema,
  tenantRole,
  type AdminAction,
  type AdminLogEntry,
  type CapabilityGrant,
  type CreateTenantInput,
  type DomainEvent,
  type DomainEventInput,
  type EntityRef,
  type CreateOrgInput,
  type IdentityLink,
  type IdentityPool,
  type Node,
  type Org,
  type OrgId,
  type PermissionKey,
  type PlatformActorId,
  type PrincipalId,
  type ResolvedIdentity,
  type RoleAssignment,
  type RoleDefinition,
  type Scope,
  type ScopeId,
  type ScopeStatus,
  type Tenant,
  type TenantId,
  type TenantRole,
  type TenantStatus,
} from '@substrat-run/contracts';
import {
  resolveScopeRecord,
  ulid,
  type AuditLogFilter,
  type ConsumerHandler,
  type GuardPredicate,
  type HostAdmin,
  type ModuleRegistration,
  type OperationContext,
  type OperationHandler,
  type PermissionChecker,
  type ProvisionScopeInput,
  type RoleFilter,
  type ScopedSql,
  type ScopeFilter,
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
    -- K-21: revocation TOMBSTONES. The row stays and the walk skips it, because a
    -- tuple that once granted access is evidence of why an access was allowed
    -- (K-4) and D-32's compliance product has to produce that evidence.
    revoked_at TEXT,
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

interface ScopeRow {
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

/**
 * The four migration-health columns → the contract's nullable `migrationFailure`.
 * All-null is the healthy case (never attempted, or the last attempt succeeded and
 * cleared them); a version present means the scope failed closed and did not serve.
 *
 * Returns the *unparsed* shape — `scopeSchema.parse` brands `lastAttemptAt` into an
 * `Instant`, the same way every other row value in `mapScope` is branded on read.
 */
function mapMigrationFailure(r: {
  migration_failed_version: string | null;
  migration_error: string | null;
  migration_attempts: number;
  migration_last_attempt_at: string | null;
}): { version: string; error: string; attempts: number; lastAttemptAt: string } | null {
  if (!r.migration_failed_version || !r.migration_last_attempt_at) return null;
  return {
    version: r.migration_failed_version,
    error: r.migration_error ?? '',
    attempts: r.migration_attempts,
    lastAttemptAt: r.migration_last_attempt_at,
  };
}

interface OrgRow {
  org_id: string;
  tenant_id: string;
  slug: string;
  name: string;
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
  /** operation name → its owning module's entitlementKey (§4.3 gate). */
  private readonly operationEntitlement = new Map<string, string>();
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
      -- The scope directory (§3.2). slug/kind/name/vertical are nullable HERE but
      -- required (except vertical) by the scope contract: the column set must be
      -- identical whether the table was created fresh or ALTERed up from the
      -- pre-directory shape (see ensureDirectoryColumns), and SQLite cannot ADD a
      -- NOT NULL column without inventing a default for existing rows. Nothing
      -- writes null — provisionScope always resolves a value, and the backfill
      -- fills legacy rows — so Zod is the enforcement point on read.
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
        -- Last FAILED migration attempt (§5.3). All null / 0 = healthy. Written on
        -- the failure path so a scope that fails closed stops rendering as active;
        -- cleared on the next success. See applyPendingMigrations.
        migration_failed_version TEXT,
        migration_error TEXT,
        migration_attempts INTEGER NOT NULL DEFAULT 0,
        migration_last_attempt_at TEXT,
        created_at TEXT NOT NULL
      );
      -- Organizations inside a tenant (K-22). Membership tuples point at these and
      -- grantToOrg targets them. Before this the id was a free-form string with no
      -- record, so a typo addressed a phantom org. The tenant_id column is also
      -- kernel-design §4.3's required orgId <-> tenantId join.
      CREATE TABLE IF NOT EXISTS orgs (
        org_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        slug TEXT NOT NULL,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS _substrat_tenant_tuples (
        tenant_id TEXT NOT NULL,
        subject TEXT NOT NULL,
        relation TEXT NOT NULL,
        object TEXT NOT NULL,
        expires_at TEXT,
        -- K-21: see the note on _substrat_tuples. Membership lives here, so this
        -- is the column removeMember writes.
        revoked_at TEXT,
        PRIMARY KEY (tenant_id, subject, relation, object)
      );
      CREATE TABLE IF NOT EXISTS _substrat_roles (
        tenant_id TEXT NOT NULL,
        role_key TEXT NOT NULL,
        permissions TEXT NOT NULL,
        source TEXT NOT NULL,
        PRIMARY KEY (tenant_id, role_key)
      );
      -- Per-tenant SKU flags (control-plane.md §4.3). A module loads for a tenant
      -- only if the tenant holds its manifest.entitlementKey — default-deny.
      CREATE TABLE IF NOT EXISTS _substrat_entitlements (
        tenant_id TEXT NOT NULL,
        entitlement_key TEXT NOT NULL,
        PRIMARY KEY (tenant_id, entitlement_key)
      );
      -- The identity seam (D-16; control-plane.md §6). An external identity
      -- (provider + external_id — an auth adapter at the edge) maps to a
      -- principal + home node. Provider-keyed so Better Auth, an OIDC issuer, or
      -- several at once coexist. Authentication input only — authorization stays
      -- in the tuples above.
      -- Registered identity pools (K-23). A provider declares its topology before it
      -- may link, so the directory knows whether the same externalId in two tenants is
      -- one human (central) or two (tenant-bound). tenant_id is non-null exactly when
      -- tenant-bound.
      CREATE TABLE IF NOT EXISTS _substrat_identity_pools (
        provider   TEXT PRIMARY KEY,
        topology   TEXT NOT NULL,
        tenant_id  TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS _substrat_identities (
        provider     TEXT NOT NULL,
        external_id  TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        tenant_id    TEXT NOT NULL,
        scope_id     TEXT,
        created_at   TEXT NOT NULL,
        PRIMARY KEY (tenant_id, provider, external_id)
      );
      -- Append-only control-plane audit trail (control-plane.md §4.4). Lives in
      -- the directory, not a scope DB: it records cross-tenant staff actions and
      -- is stamped host-side. Never UPDATEd, never DELETEd.
      CREATE TABLE IF NOT EXISTS _substrat_admin_log (
        id TEXT PRIMARY KEY,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        -- Nullable: a platform-level action targets no tenant (K-23).
        tenant_id TEXT,
        scope_id TEXT,
        vertical TEXT,
        before TEXT,
        after TEXT,
        at TEXT NOT NULL
      );
      -- Read-path indexes for the console (control-plane.md §4.5). The admin log
      -- is append-only and only grows, so every filter it offers needs one; the
      -- trailing id column makes each a covering index for the ORDER BY.
      CREATE INDEX IF NOT EXISTS _substrat_admin_log_tenant ON _substrat_admin_log (tenant_id, id);
      CREATE INDEX IF NOT EXISTS _substrat_admin_log_scope ON _substrat_admin_log (scope_id, id);
      CREATE INDEX IF NOT EXISTS _substrat_admin_log_actor ON _substrat_admin_log (actor, id);
      CREATE INDEX IF NOT EXISTS _substrat_admin_log_action ON _substrat_admin_log (action, id);
      CREATE INDEX IF NOT EXISTS _substrat_admin_log_at ON _substrat_admin_log (at);
      CREATE INDEX IF NOT EXISTS scopes_tenant ON scopes (tenant_id, scope_id);
    `);
    this.ensureDirectoryColumns();
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
      // Record which SKU flag gates this operation (§4.3). Bare defineOperation
      // bindings (tests, glue) carry no manifest and stay ungated.
      this.operationEntitlement.set(name, manifest.entitlementKey);
    }
  }

  defineOperation<I, O>(name: string, handler: OperationHandler<I, O>): void {
    if (this.withdrawn.has(name)) return; // withdrawn by another manifest — never binds
    if (this.operations.has(name)) throw new Error(`operation already defined: ${name}`);
    this.operations.set(name, handler as OperationHandler<never, unknown>);
  }

  async provisionScope(actor: PlatformActorId, input: ProvisionScopeInput): Promise<void> {
    // Mandatory active tenant (control-plane.md §4.1/§4.2): a scope with no
    // tenant record is the "tenant is an FK string" hole the registry closes —
    // fail closed, never silently create the scope orphaned.
    const tenantRow = this.directory
      .prepare('SELECT status FROM tenants WHERE tenant_id = ?')
      .get(input.tenantId) as { status: string } | undefined;
    if (!tenantRow) {
      throw new Error(`cannot provision scope under unknown tenant: ${input.tenantId}`);
    }
    if (tenantRow.status !== 'active') {
      throw new Error(
        `cannot provision scope under non-active tenant (status: ${tenantRow.status}): ${input.tenantId}`,
      );
    }
    const record = resolveScopeRecord(input);
    // Idempotency is on the scope_id (§3.3: provisioning is idempotent and
    // journaled — safe to re-run), so an existing scope short-circuits before the
    // slug check: re-provisioning does not collide with itself.
    const existing =
      this.directory.prepare('SELECT 1 FROM scopes WHERE scope_id = ?').get(input.scopeId) !==
      undefined;
    if (!existing) {
      // The `scopes_tenant_slug` UNIQUE index makes this fail closed either way;
      // checking first is what turns a SQLITE_CONSTRAINT into a sentence naming
      // the scope that already holds the slug.
      const slugOwner = this.directory
        .prepare('SELECT scope_id FROM scopes WHERE tenant_id = ? AND slug = ?')
        .get(input.tenantId, record.slug) as { scope_id: string } | undefined;
      if (slugOwner) {
        throw new Error(
          `scope slug '${record.slug}' already taken under tenant ${input.tenantId} ` +
            `by ${slugOwner.scope_id} (slugs are unique within a tenant)`,
        );
      }
      this.directory
        .prepare(
          `INSERT INTO scopes
             (scope_id, tenant_id, parent_scope_id, slug, kind, name, vertical,
              storage_shape, jurisdiction, status, created_at)
           VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, 'active', ?)`,
        )
        .run(
          input.scopeId,
          input.tenantId,
          record.slug,
          record.kind,
          record.name,
          record.vertical,
          record.storageShape,
          record.jurisdiction,
          new Date().toISOString(),
        );
    }
    const rt = this.runtime(input.tenantId, input.scopeId);
    await this.applyPendingMigrations(rt);
    // Audit a real provision only; an idempotent re-provision changed nothing.
    if (!existing) {
      this.recordAdmin(
        actor,
        'provisionScope',
        { tenantId: input.tenantId, scopeId: input.scopeId, vertical: record.vertical },
        null,
        record,
      );
    }
  }

  async getScope(
    principal: PrincipalId,
    tenantId: TenantId,
    scopeId: ScopeId,
  ): Promise<ScopeStub> {
    const row = this.directory
      .prepare('SELECT tenant_id, status FROM scopes WHERE scope_id = ?')
      .get(scopeId) as { tenant_id: string; status: string } | undefined;
    if (!row || row.tenant_id !== tenantId) {
      throw new Error(`unknown scope for tenant: (${tenantId}, ${scopeId})`);
    }

    // Lifecycle gates (control-plane.md §4.1/§4.2), all the K-3 fail-closed path.
    // The tenant record is mandatory: every scope has a tenant with a status
    // (provisioning enforces it), so a missing one is corruption, not a legacy
    // scope. A non-active tenant fails every scope under it; a non-active scope
    // fails on its own — this is what makes suspend/archive actually contain.
    const tenantRow = this.directory
      .prepare('SELECT status FROM tenants WHERE tenant_id = ?')
      .get(tenantId) as { status: string } | undefined;
    if (!tenantRow) {
      throw new Error(`scope has no tenant record: (${tenantId}, ${scopeId})`);
    }
    if (tenantRow.status !== 'active') {
      throw new Error(`tenant not active (status: ${tenantRow.status}): ${tenantId}`);
    }
    if (row.status !== 'active') {
      throw new Error(`scope not active (status: ${row.status}): ${scopeId}`);
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
        // Entitlement gate (control-plane.md §4.3): a module loads for a tenant
        // only if the tenant holds its SKU flag. Checked per invoke — the simple,
        // uncached path (K-OQ5); a DO-cached variant is a later benchmark call.
        // Fails closed the same way withdrawal does: the operation is unavailable.
        const requiredKey = this.operationEntitlement.get(operation);
        if (requiredKey && !this.tenantHoldsEntitlement(tenantId, requiredKey)) {
          return Promise.reject(
            new Error(
              `operation not entitled: ${operation} — tenant does not hold '${requiredKey}'`,
            ),
          );
        }
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

  /**
   * The single audit choke point (control-plane.md §4.4). EVERY control-plane
   * mutation — here and `provisionScope` — routes through this one method, so
   * "no mutation without a durable record" holds by construction rather than by
   * remembering a call per method. `before` is captured only where cheaply
   * readable; idempotent upserts with no cheap prior state pass `before: null`.
   */
  private recordAdmin(
    actor: PlatformActorId,
    action: AdminAction,
    target: { tenantId: TenantId | null; scopeId?: ScopeId | null; vertical?: string | null },
    before: unknown,
    after: unknown,
  ): void {
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
        target.tenantId ?? null,
        target.scopeId ?? null,
        target.vertical ?? null,
        before == null ? null : JSON.stringify(before),
        after == null ? null : JSON.stringify(after),
        new Date().toISOString(),
      );
  }

  private tenantHoldsEntitlement(tenantId: TenantId, key: string): boolean {
    return (
      this.directory
        .prepare('SELECT 1 FROM _substrat_entitlements WHERE tenant_id = ? AND entitlement_key = ?')
        .get(tenantId, key) !== undefined
    );
  }

  private buildAdmin(): HostAdmin {
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

    const readPool = (provider: string): IdentityPool | undefined => {
      const r = this.directory
        .prepare('SELECT provider, topology, tenant_id FROM _substrat_identity_pools WHERE provider = ?')
        .get(provider) as { provider: string; topology: string; tenant_id: string | null } | undefined;
      return r
        ? identityPool.parse({ provider: r.provider, topology: r.topology, tenantId: r.tenant_id })
        : undefined;
    };

    /**
     * A pool must be registered before it may link, and a tenant-bound pool may only
     * link into its own tenant. Resolution needs no equivalent check — K-22's
     * (tenantId, provider, externalId) key already scopes reads — so this is the one
     * place the topology is established rather than merely assumed.
     */
    const requirePoolServes = (provider: string, tenant: TenantId): void => {
      const pool = readPool(provider);
      if (!pool) {
        throw new Error(
          `identity pool '${provider}' is not registered — a pool must declare its ` +
            `topology before it may link (central vs tenant-bound decides whether the ` +
            `same externalId in two tenants is one person or two)`,
        );
      }
      if (pool.topology === 'tenant-bound' && pool.tenantId !== tenant) {
        throw new Error(
          `identity pool '${provider}' is bound to tenant ${pool.tenantId} and cannot link into ${tenant}`,
        );
      }
    };

    const mapOrg = (r: OrgRow): Org =>
      orgSchema.parse({
        id: r.org_id,
        tenantId: r.tenant_id,
        slug: r.slug,
        name: r.name,
        createdAt: r.created_at,
      });

    // Scoped by tenant, not just by id: an org id from another tenant must read as
    // absent here, or `grantToOrg` would reach across the boundary the record exists
    // to make explicit.
    const readOrg = (tenant: TenantId, id: OrgId): Org | undefined => {
      const r = this.directory
        .prepare('SELECT * FROM orgs WHERE tenant_id = ? AND org_id = ?')
        .get(tenant, id) as OrgRow | undefined;
      return r ? mapOrg(r) : undefined;
    };

    /**
     * Fail closed on an org that does not exist in this tenant. This is what the
     * record buys: before it, membership and grants accepted any string, so a typo
     * produced a tuple pointing at a phantom that silently granted nothing and
     * appeared in no listing.
     */
    const requireOrg = (tenant: TenantId, id: OrgId): void => {
      if (!readOrg(tenant, id)) {
        throw new Error(`unknown org ${id} in tenant ${tenant}`);
      }
    };

    // The directory row → the `scope` contract. Parsed, not cast: the columns are
    // nullable in SQLite (ALTER TABLE cannot add NOT NULL to a populated table)
    // while the contract requires them, so this parse is where that gap is held
    // shut. A null slug reaching here means the backfill missed a row — which
    // should fail loudly rather than surface as an untyped hole in the console.
    const mapScope = (r: ScopeRow): Scope =>
      scopeSchema.parse({
        id: r.scope_id,
        tenantId: r.tenant_id,
        parentScopeId: r.parent_scope_id,
        slug: r.slug,
        kind: r.kind,
        name: r.name,
        status: r.status,
        storageShape: r.storage_shape,
        jurisdiction: r.jurisdiction,
        vertical: r.vertical,
        schemaVersion: r.schema_version,
        migrationFailure: mapMigrationFailure(r),
        createdAt: r.created_at,
      });

    // Scope lifecycle transition (control-plane.md §4.2): validate ownership,
    // enforce the legal transition graph (fail closed on an illegal one), flip
    // the status, and audit before/after. un-archive is just another entry here
    // — an explicit, audited restore, never a silent flag flip.
    const transitionScope = (
      actor: PlatformActorId,
      action: AdminAction,
      tenantId: TenantId,
      scopeId: ScopeId,
      from: ScopeStatus[],
      to: ScopeStatus,
    ) => {
      const row = this.directory
        .prepare('SELECT tenant_id, status, vertical FROM scopes WHERE scope_id = ?')
        .get(scopeId) as { tenant_id: string; status: string; vertical: string | null } | undefined;
      if (!row || row.tenant_id !== tenantId) {
        throw new Error(`unknown scope for tenant: (${tenantId}, ${scopeId})`);
      }
      if (!from.includes(row.status as ScopeStatus)) {
        throw new Error(
          `illegal scope transition for ${action}: ${row.status} → ${to} ` +
            `(allowed from: ${from.join('|')})`,
        );
      }
      this.directory.prepare('UPDATE scopes SET status = ? WHERE scope_id = ?').run(to, scopeId);
      // The audit target carries the scope's vertical (control-plane.md §4.4:
      // "vertical stays null until §4.2 lifecycle actions that name one"). It is
      // read from the scope rather than passed in, so the trail cannot disagree
      // with the directory about which deployment the action touched.
      this.recordAdmin(
        actor,
        action,
        { tenantId, scopeId, vertical: row.vertical },
        { status: row.status },
        { status: to },
      );
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
      defineRole: async (actor: PlatformActorId, tenantId: TenantId, role: RoleDefinition) => {
        const parsed = roleDefinition.parse(role);
        const before = this.roles.get(`${tenantId}/${parsed.key}`) ?? null;
        this.directory
          .prepare(
            `INSERT OR REPLACE INTO _substrat_roles (tenant_id, role_key, permissions, source)
             VALUES (?, ?, ?, ?)`,
          )
          .run(tenantId, parsed.key, JSON.stringify(parsed.permissions), String(parsed.source));
        this.roles.set(`${tenantId}/${parsed.key}`, parsed);
        this.recordAdmin(actor, 'defineRole', { tenantId }, before, parsed);
      },
      listRoles: async (filter?: RoleFilter): Promise<TenantRole[]> => {
        const where: string[] = [];
        const params: string[] = [];
        if (filter?.tenantId) {
          where.push('tenant_id = ?');
          params.push(filter.tenantId);
        }
        if (filter?.source) {
          where.push('source = ?');
          params.push(filter.source);
        }
        const sql =
          'SELECT tenant_id, role_key, permissions, source FROM _substrat_roles' +
          (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
          ' ORDER BY tenant_id, role_key';
        const rows = this.directory.prepare(sql).all(...params) as {
          tenant_id: string;
          role_key: string;
          permissions: string;
          source: string;
        }[];
        // Parsed, not cast: `permissions` is a JSON blob in a TEXT column, so the
        // contract is the only thing standing between a corrupted row and the
        // console rendering a role with permissions nobody declared.
        return rows.map((r) =>
          tenantRole.parse({
            tenantId: r.tenant_id,
            key: r.role_key,
            permissions: JSON.parse(r.permissions),
            source: r.source,
          }),
        );
      },
      assignRole: async (actor: PlatformActorId, assignment: RoleAssignment) => {
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
        this.recordAdmin(
          actor,
          'assignRole',
          { tenantId: assignment.node.tenantId, scopeId: assignment.node.scopeId },
          null,
          assignment,
        );
      },
      grant: async (actor: PlatformActorId, grant: CapabilityGrant) => {
        writeGrant(
          `principal:${grant.principalId}`,
          grant.permission,
          grant.node,
          grant.entity,
          grant.expiresAt,
        );
        this.recordAdmin(
          actor,
          'grant',
          { tenantId: grant.node.tenantId, scopeId: grant.node.scopeId },
          null,
          grant,
        );
      },
      grantToOrg: async (actor, orgId, permission, node, entity) => {
        // The org must exist in the node's tenant. A grant to a phantom org is
        // worse than an error: it looks applied, resolves for nobody, and shows up
        // in the permission diff as though access were conferred.
        requireOrg(node.tenantId, orgId);
        writeGrant(`org:${orgId}`, permission, node, entity);
        this.recordAdmin(
          actor,
          'grantToOrg',
          { tenantId: node.tenantId, scopeId: node.scopeId },
          null,
          { orgId, permission, node, entity },
        );
      },
      createOrg: async (actor: PlatformActorId, input: CreateOrgInput) => {
        const parsed = createOrgInput.parse(input);
        if (readOrg(parsed.tenantId, parsed.id)) return; // idempotent, unaudited
        // Checked explicitly rather than left to the UNIQUE index: OR IGNORE would
        // swallow a collision from a DIFFERENT id and report success, silently not
        // creating the org the caller asked for. Fail closed instead (as createTenant).
        const slugOwner = this.directory
          .prepare('SELECT org_id FROM orgs WHERE tenant_id = ? AND slug = ?')
          .get(parsed.tenantId, parsed.slug) as { org_id: string } | undefined;
        if (slugOwner) {
          throw new Error(
            `org slug '${parsed.slug}' already taken by ${slugOwner.org_id} (slugs are unique per tenant)`,
          );
        }
        this.directory
          .prepare(
            'INSERT INTO orgs (org_id, tenant_id, slug, name, created_at) VALUES (?, ?, ?, ?, ?)',
          )
          .run(parsed.id, parsed.tenantId, parsed.slug, parsed.name, new Date().toISOString());
        this.recordAdmin(actor, 'createOrg', { tenantId: parsed.tenantId }, null, parsed);
      },
      listOrgs: async (tenantId: TenantId) =>
        (
          this.directory
            .prepare('SELECT * FROM orgs WHERE tenant_id = ? ORDER BY slug')
            .all(tenantId) as OrgRow[]
        ).map(mapOrg),
      getOrg: async (tenantId: TenantId, orgId: OrgId) => readOrg(tenantId, orgId),
      addMember: async (actor, tenantId, principal, orgId) => {
        requireOrg(tenantId, orgId);
        // INSERT OR REPLACE, so re-adding a revoked member clears the tombstone —
        // they are a member again. The add/revoke history is not lost: it lives in
        // the append-only admin log, which is where "what happened" belongs. The
        // tuple carries "what is true now" plus enough to explain a live proof.
        writeTenantTuple(tenantId, `principal:${principal}`, 'member', `org:${orgId}`);
        this.recordAdmin(actor, 'addMember', { tenantId }, null, { principal, orgId });
      },
      removeMember: async (actor, tenantId, principal, orgId) => {
        requireOrg(tenantId, orgId);
        // Tombstone (K-21), never DELETE. Guarded on `revoked_at IS NULL` so a
        // repeat revoke neither moves the timestamp nor writes a second audit row.
        const info = this.directory
          .prepare(
            `UPDATE _substrat_tenant_tuples SET revoked_at = ?
             WHERE tenant_id = ? AND subject = ? AND relation = 'member' AND object = ?
               AND revoked_at IS NULL`,
          )
          .run(
            new Date().toISOString(),
            tenantId,
            `principal:${principal}`,
            `org:${orgId}`,
          );
        if (info.changes === 0) return; // never a member, or already revoked
        this.recordAdmin(actor, 'removeMember', { tenantId }, { principal, orgId }, null);
      },
      listMembers: async (tenantId, orgId, options) => {
        requireOrg(tenantId, orgId);
        const rows = this.directory
          .prepare(
            `SELECT subject, revoked_at FROM _substrat_tenant_tuples
             WHERE tenant_id = ? AND relation = 'member' AND object = ?
             ${options?.includeRevoked ? '' : 'AND revoked_at IS NULL'}
             ORDER BY subject`,
          )
          .all(tenantId, `org:${orgId}`) as { subject: string; revoked_at: string | null }[];
        return rows.map((r) =>
          orgMembership.parse({
            principal: r.subject.slice('principal:'.length),
            orgId,
            revokedAt: r.revoked_at,
          }),
        );
      },
      createTenant: async (actor: PlatformActorId, input: CreateTenantInput) => {
        const parsed = createTenantInput.parse(input);
        // Idempotent: re-creating an existing tenant is a no-op, and a no-op is
        // not audited — nothing changed.
        if (readTenant(parsed.id)) return;
        // Checked explicitly rather than left to `INSERT OR IGNORE` + the
        // `tenants_slug` UNIQUE index: OR IGNORE would swallow a collision from a
        // DIFFERENT id and return as though the create were idempotent, silently
        // not creating the tenant the caller asked for. Fail closed instead.
        const slugOwner = this.directory
          .prepare('SELECT tenant_id FROM tenants WHERE slug = ?')
          .get(parsed.slug) as { tenant_id: string } | undefined;
        if (slugOwner) {
          throw new Error(
            `tenant slug '${parsed.slug}' already taken by ${slugOwner.tenant_id} (slugs are unique)`,
          );
        }
        this.directory
          .prepare(
            `INSERT INTO tenants (tenant_id, slug, name, status, created_at)
             VALUES (?, ?, ?, 'active', ?)`,
          )
          .run(parsed.id, parsed.slug, parsed.name, new Date().toISOString());
        this.recordAdmin(actor, 'createTenant', { tenantId: parsed.id }, null, readTenant(parsed.id));
      },
      setTenantStatus: async (actor: PlatformActorId, tenantId: TenantId, status: TenantStatus) => {
        const before = readTenant(tenantId);
        if (!before) throw new Error(`unknown tenant: ${tenantId}`);
        this.directory
          .prepare('UPDATE tenants SET status = ? WHERE tenant_id = ?')
          .run(status, tenantId);
        this.recordAdmin(
          actor,
          'setTenantStatus',
          { tenantId },
          { status: before.status },
          { status },
        );
      },
      listTenants: async (): Promise<Tenant[]> =>
        (this.directory.prepare('SELECT * FROM tenants ORDER BY tenant_id').all() as TenantRow[]).map(
          mapTenant,
        ),
      getTenant: async (tenantId: TenantId): Promise<Tenant | undefined> => readTenant(tenantId),
      listScopes: async (filter?: ScopeFilter): Promise<Scope[]> => {
        const where: string[] = [];
        const params: (string | number)[] = [];
        if (filter?.tenantId) {
          where.push('tenant_id = ?');
          params.push(filter.tenantId);
        }
        if (filter?.status) {
          const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
          // An empty array means "no status is acceptable" — match nothing, rather
          // than degenerating into an unfiltered read of the whole fleet.
          if (statuses.length === 0) return [];
          where.push(`status IN (${statuses.map(() => '?').join(', ')})`);
          params.push(...statuses);
        }
        if (filter?.vertical) {
          where.push('vertical = ?');
          params.push(filter.vertical);
        }
        const sql =
          'SELECT * FROM scopes' +
          (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
          ' ORDER BY scope_id';
        return (this.directory.prepare(sql).all(...params) as ScopeRow[]).map(mapScope);
      },
      getScopeRecord: async (tenantId: TenantId, scopeId: ScopeId): Promise<Scope | undefined> => {
        const r = this.directory.prepare('SELECT * FROM scopes WHERE scope_id = ?').get(scopeId) as
          | ScopeRow
          | undefined;
        // Cross-check the pair (K-3): a scope that exists under a DIFFERENT tenant
        // reads as absent, never as itself. Same rule as getScope's stub mint.
        if (!r || r.tenant_id !== tenantId) return undefined;
        return mapScope(r);
      },
      suspendScope: async (actor, tenantId, scopeId) =>
        transitionScope(actor, 'suspendScope', tenantId, scopeId, ['active'], 'suspended'),
      unsuspendScope: async (actor, tenantId, scopeId) =>
        transitionScope(actor, 'unsuspendScope', tenantId, scopeId, ['suspended'], 'active'),
      archiveScope: async (actor, tenantId, scopeId) =>
        transitionScope(actor, 'archiveScope', tenantId, scopeId, ['active', 'suspended'], 'archived'),
      unarchiveScope: async (actor, tenantId, scopeId) =>
        transitionScope(actor, 'unarchiveScope', tenantId, scopeId, ['archived'], 'active'),
      grantEntitlement: async (actor: PlatformActorId, tenantId: TenantId, entitlementKey: string) => {
        const info = this.directory
          .prepare(
            `INSERT OR IGNORE INTO _substrat_entitlements (tenant_id, entitlement_key)
             VALUES (?, ?)`,
          )
          .run(tenantId, entitlementKey);
        // Idempotent: granting a held flag changed nothing, so it is not audited.
        if (info.changes === 0) return;
        this.recordAdmin(actor, 'grantEntitlement', { tenantId }, null, { entitlementKey });
      },
      revokeEntitlement: async (actor: PlatformActorId, tenantId: TenantId, entitlementKey: string) => {
        const info = this.directory
          .prepare(
            'DELETE FROM _substrat_entitlements WHERE tenant_id = ? AND entitlement_key = ?',
          )
          .run(tenantId, entitlementKey);
        if (info.changes === 0) return; // nothing held, nothing changed
        this.recordAdmin(actor, 'revokeEntitlement', { tenantId }, { entitlementKey }, null);
      },
      listEntitlements: async (tenantId: TenantId): Promise<string[]> =>
        (
          this.directory
            .prepare(
              'SELECT entitlement_key FROM _substrat_entitlements WHERE tenant_id = ? ORDER BY entitlement_key',
            )
            .all(tenantId) as { entitlement_key: string }[]
        ).map((r) => r.entitlement_key),
      registerIdentityPool: async (actor: PlatformActorId, input: IdentityPool) => {
        const parsed = identityPool.parse(input);
        const existing = readPool(parsed.provider);
        if (existing) {
          // Idempotent on an identical registration. A CONFLICTING one throws:
          // flipping a live pool's topology silently reinterprets every row it owns
          // — the same externalId across tenants would change from one human to two.
          if (existing.topology === parsed.topology && existing.tenantId === parsed.tenantId) {
            return;
          }
          throw new Error(
            `identity pool '${parsed.provider}' is already registered as ${existing.topology}` +
              `${existing.tenantId ? ` for tenant ${existing.tenantId}` : ''}`,
          );
        }
        this.directory
          .prepare(
            'INSERT INTO _substrat_identity_pools (provider, topology, tenant_id, created_at) VALUES (?, ?, ?, ?)',
          )
          .run(parsed.provider, parsed.topology, parsed.tenantId, new Date().toISOString());
        this.recordAdmin(
          actor,
          'registerIdentityPool',
          // Null for a central pool: it belongs to no single tenant, which is what
          // made the admin log's tenantId nullable.
          { tenantId: parsed.tenantId },
          null,
          parsed,
        );
      },
      getIdentityPool: async (provider: string) => readPool(provider),
      listIdentityTenants: async (provider: string, externalId: string) => {
        const pool = readPool(provider);
        if (!pool) throw new Error(`identity pool '${provider}' is not registered`);
        if (pool.topology !== 'central') {
          throw new Error(
            `identity pool '${provider}' is tenant-bound — enumerating tenants is only ` +
              `meaningful on a central pool, where the same externalId is the same person`,
          );
        }
        return (
          this.directory
            .prepare(
              'SELECT tenant_id FROM _substrat_identities WHERE provider = ? AND external_id = ? ORDER BY tenant_id',
            )
            .all(provider, externalId) as { tenant_id: string }[]
        ).map((r) => r.tenant_id as TenantId);
      },
      linkIdentity: async (actor: PlatformActorId, input: IdentityLink) => {
        const parsed = identityLink.parse(input);
        requirePoolServes(parsed.provider, parsed.tenantId);
        // Read before write. `INSERT OR IGNORE` alone cannot tell "already bound to the
        // same principal" (idempotent) from "already bound to someone else" (a
        // collision), and silently ignoring the second resolves one person as another.
        const existing = this.directory
          .prepare(
            `SELECT principal_id FROM _substrat_identities
             WHERE tenant_id = ? AND provider = ? AND external_id = ?`,
          )
          .get(parsed.tenantId, parsed.provider, parsed.externalId) as
          | { principal_id: string }
          | undefined;
        if (existing) {
          if (existing.principal_id === parsed.principal) return; // idempotent, unaudited
          throw new Error(
            `identity ${parsed.provider}:${parsed.externalId} in tenant ${parsed.tenantId} ` +
              `is already bound to ${existing.principal_id}`,
          );
        }
        this.directory
          .prepare(
            `INSERT INTO _substrat_identities
               (provider, external_id, principal_id, tenant_id, scope_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            parsed.provider,
            parsed.externalId,
            parsed.principal,
            parsed.tenantId,
            parsed.scopeId ?? null,
            new Date().toISOString(),
          );
        this.recordAdmin(
          actor,
          'linkIdentity',
          { tenantId: parsed.tenantId, scopeId: parsed.scopeId },
          null,
          { provider: parsed.provider, externalId: parsed.externalId, principal: parsed.principal },
        );
      },
      resolveIdentity: async (
        tenantId: TenantId,
        provider: string,
        externalId: string,
      ): Promise<ResolvedIdentity | undefined> => {
        const row = this.directory
          .prepare(
            `SELECT principal_id, scope_id FROM _substrat_identities
             WHERE tenant_id = ? AND provider = ? AND external_id = ?`,
          )
          .get(tenantId, provider, externalId) as
          | { principal_id: string; scope_id: string | null }
          | undefined;
        if (!row) return undefined;
        return resolvedIdentity.parse({ principal: row.principal_id, scopeId: row.scope_id });
      },
      auditLog: async (filter?: AuditLogFilter): Promise<AdminLogEntry[]> => {
        const where: string[] = [];
        const params: (string | number)[] = [];
        if (filter?.tenantId) {
          where.push('tenant_id = ?');
          params.push(filter.tenantId);
        }
        if (filter?.scopeId) {
          where.push('scope_id = ?');
          params.push(filter.scopeId);
        }
        if (filter?.actor) {
          where.push('actor = ?');
          params.push(filter.actor);
        }
        if (filter?.action) {
          const actions = Array.isArray(filter.action) ? filter.action : [filter.action];
          if (actions.length === 0) return []; // no action is acceptable — match nothing
          where.push(`action IN (${actions.map(() => '?').join(', ')})`);
          params.push(...actions);
        }
        if (filter?.since) {
          where.push('at >= ?');
          params.push(filter.since);
        }
        if (filter?.until) {
          where.push('at < ?');
          params.push(filter.until);
        }
        const order = filter?.order === 'desc' ? 'DESC' : 'ASC';
        if (filter?.cursor) {
          // ULID order is chronological, so the entry id IS the cursor: page
          // forward past it in asc, backward before it in desc.
          where.push(order === 'DESC' ? 'id < ?' : 'id > ?');
          params.push(filter.cursor);
        }
        let sql =
          'SELECT * FROM _substrat_admin_log' +
          (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
          ` ORDER BY id ${order}`;
        if (filter?.limit !== undefined) {
          sql += ' LIMIT ?';
          params.push(filter.limit);
        }
        const rows = this.directory.prepare(sql).all(...params) as AdminLogRow[];
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

  /**
   * The directory's own migration path (control-plane.md §7: "the directory
   * becomes a real database, with its own migrations"). It is not a module, so
   * it has no `SqlMigration[]` journal — but a dev directory created before the
   * scope record grew its naming columns must still open. ALTER in what's
   * missing, backfill legacy rows to the same defaults `provisionScope` applies,
   * then add the uniqueness the contract has always claimed ("slug — unique
   * within tenant"). Idempotent: on a fresh directory every column already
   * exists and every UPDATE matches nothing.
   */
  /**
   * Additive column migration for a table that already exists in someone's data
   * directory. `PRAGMA table_info` is available in the pure adapter (the DO adapter
   * has to attempt-and-tolerate instead — see its `ensureDirectoryColumns`).
   */
  private ensureColumn(db: Database.Database, table: string, column: string, ddl: string): void {
    const existing = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some(
      (c) => c.name === column,
    );
    if (!existing) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }

  /**
   * Rebuild `_substrat_identities` when it still carries the pre-K-22 global key.
   * A PRIMARY KEY cannot be ALTERed, so this is create-copy-drop-rename.
   *
   * The old shape is detected from `sqlite_master.sql` rather than `PRAGMA table_info`
   * (which reports PK membership but not composition readably), and because the same
   * check works on DO SQLite, where PRAGMA is restricted — so both adapters can use
   * one detection strategy.
   *
   * Rows carry `tenant_id` already, so the copy is lossless: what changes is which
   * columns are unique, not what is stored. Two pools that both issued `123` were
   * previously ONE row (the second link silently ignored); after the rebuild the
   * surviving row keeps its tenant and the other tenant's link can be made again.
   */
  private ensureIdentityKey(): void {
    const row = this.directory
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get('_substrat_identities') as { sql: string } | undefined;
    if (!row || row.sql.includes('PRIMARY KEY (tenant_id, provider, external_id)')) return;
    this.directory.exec(`
      CREATE TABLE _substrat_identities_new (
        provider     TEXT NOT NULL,
        external_id  TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        tenant_id    TEXT NOT NULL,
        scope_id     TEXT,
        created_at   TEXT NOT NULL,
        PRIMARY KEY (tenant_id, provider, external_id)
      );
      INSERT OR IGNORE INTO _substrat_identities_new
        (provider, external_id, principal_id, tenant_id, scope_id, created_at)
        SELECT provider, external_id, principal_id, tenant_id, scope_id, created_at
        FROM _substrat_identities;
      DROP TABLE _substrat_identities;
      ALTER TABLE _substrat_identities_new RENAME TO _substrat_identities;
    `);
  }

  /**
   * Drop the admin log's `tenant_id NOT NULL` (K-23). SQLite cannot relax a column
   * constraint in place, so this is the same create-copy-drop-rename the identity key
   * uses, detected the same way — from `sqlite_master.sql`, which works on DO SQLite
   * too. Rows are copied verbatim: the log stays append-only in content, this only
   * widens what a future row may say.
   */
  private ensureAdminLogTenantNullable(): void {
    const row = this.directory
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get('_substrat_admin_log') as { sql: string } | undefined;
    if (!row || !/tenant_id TEXT NOT NULL/.test(row.sql)) return;
    this.directory.exec(`
      CREATE TABLE _substrat_admin_log_new (
        id TEXT PRIMARY KEY,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        tenant_id TEXT,
        scope_id TEXT,
        vertical TEXT,
        before TEXT,
        after TEXT,
        at TEXT NOT NULL
      );
      INSERT INTO _substrat_admin_log_new
        SELECT id, actor, action, tenant_id, scope_id, vertical, before, after, at
        FROM _substrat_admin_log;
      DROP TABLE _substrat_admin_log;
      ALTER TABLE _substrat_admin_log_new RENAME TO _substrat_admin_log;
    `);
  }

  private ensureDirectoryColumns(): void {
    this.ensureIdentityKey();
    this.ensureAdminLogTenantNullable();
    // K-21's tombstone on tenant-level tuples (membership lives here).
    this.ensureColumn(this.directory, '_substrat_tenant_tuples', 'revoked_at', 'revoked_at TEXT');
    const existing = new Set(
      (this.directory.prepare('PRAGMA table_info(scopes)').all() as { name: string }[]).map(
        (c) => c.name,
      ),
    );
    for (const [column, ddl] of [
      ['parent_scope_id', 'parent_scope_id TEXT'],
      ['slug', 'slug TEXT'],
      ['kind', 'kind TEXT'],
      ['name', 'name TEXT'],
      ['vertical', 'vertical TEXT'],
      ['migration_failed_version', 'migration_failed_version TEXT'],
      ['migration_error', 'migration_error TEXT'],
      ['migration_attempts', 'migration_attempts INTEGER NOT NULL DEFAULT 0'],
      ['migration_last_attempt_at', 'migration_last_attempt_at TEXT'],
    ] as const) {
      if (!existing.has(column)) this.directory.exec(`ALTER TABLE scopes ADD COLUMN ${ddl}`);
    }
    // A ULID lowercases into a valid slug, so the placeholder is unique by
    // construction — the same default provisionScope resolves.
    this.directory.exec(`
      UPDATE scopes SET slug = lower(scope_id) WHERE slug IS NULL;
      UPDATE scopes SET kind = 'scope' WHERE kind IS NULL;
      UPDATE scopes SET name = slug WHERE name IS NULL;
    `);
    // Created after the backfill: a UNIQUE index over NULL slugs would permit the
    // duplicates it exists to forbid (SQLite treats NULLs as distinct).
    this.directory.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS scopes_tenant_slug ON scopes (tenant_id, slug)',
    );
    this.directory.exec('CREATE UNIQUE INDEX IF NOT EXISTS tenants_slug ON tenants (slug)');
    this.directory.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS orgs_tenant_slug ON orgs (tenant_id, slug)',
    );
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

  private async applyPendingMigrations(rt: ScopeRuntime): Promise<void> {
    const pending: { moduleId: string; migration: SqlMigration }[] = [];
    for (const mod of this.modules.values()) {
      for (const migration of mod.migrations) {
        if (!rt.appliedMigrations.has(`${mod.id}@${migration.version}`)) {
          pending.push({ moduleId: mod.id, migration });
        }
      }
    }
    // Nothing pending → nothing to record. A scope provisioned before any module
    // registers legitimately sits at schema_version '0'.
    if (pending.length === 0) return;
    // The failing `module@version` and its cause, captured structurally rather than
    // re-parsed out of the thrown message — the directory record has to name both.
    let failure: { version: string; error: string } | undefined;
    try {
      await rt.actor.enqueue(() => {
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
            failure = { version: key, error: (err as Error).message };
            throw new Error(
              `migration failed for ${key} — scope fails closed: ${(err as Error).message}`,
            );
          }
          rt.appliedMigrations.add(key);
        }
      });
    } finally {
      // `finally`, not the success path: a scope that failed closed is exactly the
      // one the fleet needs to see, and projecting only on success is what let a
      // half-migrated scope keep a stale `schema_version` and render as healthy
      // (#32). The throw still propagates — recording is not recovering.
      this.recordMigrationState(rt, failure);
    }
  }

  /**
   * Project a scope's migration state into the directory — §5.4's "fleet questions
   * never fan out", so the index answers "which scopes are behind" and "which
   * failed" without waking anything.
   *
   * `appliedMigrations.size` is written on both paths: after a partial failure it
   * is the count that actually landed, which is more truthful than the pre-attempt
   * value. On success the failure columns are cleared, so `attempts` counts
   * *consecutive* failures — what the sweep's backoff (#49) needs.
   */
  private recordMigrationState(
    rt: ScopeRuntime,
    failure: { version: string; error: string } | undefined,
  ): void {
    const version = String(rt.appliedMigrations.size);
    if (!failure) {
      this.directory
        .prepare(
          `UPDATE scopes SET schema_version = ?, migration_failed_version = NULL,
             migration_error = NULL, migration_attempts = 0, migration_last_attempt_at = NULL
           WHERE scope_id = ?`,
        )
        .run(version, rt.scopeId);
      return;
    }
    this.directory
      .prepare(
        `UPDATE scopes SET schema_version = ?, migration_failed_version = ?,
           migration_error = ?, migration_attempts = migration_attempts + 1,
           migration_last_attempt_at = ?
         WHERE scope_id = ?`,
      )
      .run(version, failure.version, failure.error, new Date().toISOString(), rt.scopeId);
  }

  private runtime(tenantId: TenantId, scopeId: ScopeId): ScopeRuntime {
    const key = `${tenantId}/${scopeId}`;
    const existing = this.scopes.get(key);
    if (existing) return existing;
    const db = new Database(join(this.dir, `${tenantId}__${scopeId}.sqlite`));
    db.pragma('journal_mode = WAL');
    db.exec(KERNEL_DDL);
    // KERNEL_DDL is all IF NOT EXISTS, so a scope DB created before K-21 keeps the
    // old shape — ALTER the tombstone in.
    this.ensureColumn(db, '_substrat_tuples', 'revoked_at', 'revoked_at TEXT');
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
