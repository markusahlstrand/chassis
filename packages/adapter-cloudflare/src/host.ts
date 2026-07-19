import {
  adminLogEntry,
  createTenantInput,
  identityLink,
  createOrgInput,
  moduleManifest,
  org as orgSchema,
  orgMembership,
  resolvedIdentity,
  roleDefinition,
  scope as scopeSchema,
  tenant as tenantSchema,
  tenantRole,
  type AdminAction,
  type AdminLogEntry,
  type CapabilityGrant,
  type CreateOrgInput,
  type CreateTenantInput,
  type EntityRef,
  type IdentityLink,
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
  type HostAdmin,
  type ModuleRegistration,
  type OperationHandler,
  type PermissionChecker,
  type ProvisionScopeInput,
  type RoleFilter,
  type ScopeFilter,
  type ScopeHost,
  type ScopeStub,
} from '@substrat-run/kernel';
import type { AuditLogQuery, OrgRow, RoleRow, ScopeRow } from './control-plane-do.js';

/**
 * `CloudflareScopeHost` — the coordinator (design doc §5.7). It runs in the
 * Worker isolate; every scope's execution runs in a ScopeDO, and the whole
 * directory lives in the singleton ControlPlaneDO. This facade is the seam
 * between them.
 *
 * The directory is now DURABLE. `HostAdmin` is an ASYNCHRONOUS interface (D-14):
 * every method returns a Promise, which is exactly what lets the tenant
 * registry, scope lifecycle, roles, entitlements, identities, and the admin
 * audit log live in the ControlPlaneDO rather than in Worker-isolate memory — a
 * production coordinator is stateless across requests, so nothing directory-
 * shaped may be held here. Each admin method `await`s its RPCs directly (the
 * ControlPlaneDO is single-threaded, so write order is preserved) and audits
 * only when the effect actually changed something, mirroring the pure adapter's
 * idempotency. Provision and getScope gate against the ControlPlaneDO too.
 *
 * What the coordinator DOES keep in memory is registration-mechanics bookkeeping
 * (module ids, operation bindings, withdrawals, the entitlement key per
 * operation): that is code-time, derived from the bundled modules, not durable
 * directory state.
 *
 * Tuple ROUTING stays here (the scope-tuples-live-in-ScopeDO invariant the
 * checker depends on): scope-level tuples → the owning ScopeDO via
 * `scopeStub().writeTuple`; tenant-level tuples → `cp.writeTenantTuple`. Zod
 * parsing stays here too, so only clean data crosses to the DO and the DO throws
 * only plain Errors whose messages survive the RPC hop.
 */

interface ControlPlaneStub {
  createTenant(id: string, slug: string, name: string, createdAt: string): Promise<Tenant | null>;
  setTenantStatus(tenantId: string, status: TenantStatus): Promise<string>;
  getTenant(tenantId: string): Promise<Tenant | undefined>;
  listTenants(): Promise<Tenant[]>;
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
  ): Promise<boolean>;
  setMigrationState(
    scopeId: string,
    schemaVersion: string,
    failure: { version: string; error: string } | null,
  ): Promise<void>;
  listScopes(filter: { tenantId?: string; status?: string[]; vertical?: string }): Promise<ScopeRow[]>;
  getScopeRecord(tenantId: string, scopeId: string): Promise<ScopeRow | undefined>;
  validateScopeAccess(tenantId: string, scopeId: string): Promise<void>;
  transitionScope(
    tenantId: string,
    scopeId: string,
    from: string[],
    to: ScopeStatus,
    action: string,
  ): Promise<{ status: string; vertical: string | null }>;
  defineRole(tenantId: string, role: RoleDefinition): Promise<RoleDefinition | null>;
  listRoles(filter: { tenantId?: string; source?: string }): Promise<RoleRow[]>;
  writeTenantTuple(
    tenantId: string,
    subject: string,
    relation: string,
    object: string,
    expiresAt: string | null,
  ): Promise<void>;
  readOrg(tenantId: string, orgId: string): Promise<OrgRow | undefined>;
  createOrg(
    orgId: string,
    tenantId: string,
    slug: string,
    name: string,
    createdAt: string,
  ): Promise<boolean>;
  listOrgs(tenantId: string): Promise<OrgRow[]>;
  /** K-21 tombstone. Returns whether anything changed (idempotent revoke). */
  revokeMember(tenantId: string, subject: string, object: string, at: string): Promise<boolean>;
  listMembers(
    tenantId: string,
    object: string,
    includeRevoked: boolean,
  ): Promise<{ subject: string; revoked_at: string | null }[]>;
  grantEntitlement(tenantId: string, key: string): Promise<boolean>;
  revokeEntitlement(tenantId: string, key: string): Promise<boolean>;
  tenantHoldsEntitlement(tenantId: string, key: string): Promise<boolean>;
  listEntitlements(tenantId: string): Promise<string[]>;
  linkIdentity(
    provider: string,
    externalId: string,
    principal: string,
    tenantId: string,
    scopeId: string | null,
    createdAt: string,
  ): Promise<boolean>;
  resolveIdentity(
    provider: string,
    externalId: string,
  ): Promise<{ principal: string; tenantId: string; scopeId: string | null } | undefined>;
  recordAdmin(entry: AdminEntry): Promise<void>;
  auditLog(query: AuditLogQuery): Promise<AdminLogEntry[]>;
}

interface AdminEntry {
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

interface ScopeStubRpc {
  /** The applied-migration count if this call applied any, else null (nothing changed). */
  migrate(): Promise<number | null>;
  /** The migration that failed on this instance, read on `migrate()`'s reject path. */
  migrationFailure(): Promise<{ version: string; error: string; applied: number } | null>;
  invoke(
    operation: string,
    input: unknown,
    principal: PrincipalId,
    tenantId: TenantId,
    scopeId: ScopeId,
  ): Promise<unknown>;
  writeTuple(
    subject: string,
    relation: string,
    object: string,
    expiresAt: string | null,
  ): Promise<void>;
}

export interface CloudflareScopeHostOptions {
  scope: DurableObjectNamespace;
  controlPlane: DurableObjectNamespace;
  /**
   * Accepted for parity with the pure adapter's constructor. In milestone 1 the
   * ScopeDO owns permission evaluation (a checker function cannot cross the RPC
   * boundary), so this is informational only — the DO builds the tuple checker.
   */
  checker?: PermissionChecker;
}

export class CloudflareScopeHost implements ScopeHost {
  readonly admin: HostAdmin;

  private readonly scopeNs: DurableObjectNamespace;
  private readonly cp: ControlPlaneStub;

  // Registration-mechanics bookkeeping (validation only — the DO executes).
  // Code-time, derived from the bundled modules, NOT durable directory state.
  private readonly moduleIds = new Set<string>();
  private readonly operations = new Set<string>();
  private readonly predicateNames = new Map<string, string>(); // name → module
  private readonly withdrawn = new Map<string, string>(); // operation → module
  private readonly operationEntitlement = new Map<string, string>();

  constructor(options: CloudflareScopeHostOptions) {
    this.scopeNs = options.scope;
    this.cp = options.controlPlane.get(
      options.controlPlane.idFromName('control-plane'),
    ) as unknown as ControlPlaneStub;
    this.admin = this.buildAdmin();
  }

  // -- registration mechanics (validation only) -----------------------------

  registerModule(registration: ModuleRegistration): void {
    const manifest = moduleManifest.parse(registration.manifest);
    if (this.moduleIds.has(manifest.id)) {
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
    for (const eventType of Object.keys(registration.consumers ?? {})) {
      if (!declaredConsumes.has(eventType)) {
        throw new Error(
          `${manifest.id} registers a consumer for undeclared event type: ${eventType}`,
        );
      }
    }
    for (const name of Object.keys(registration.predicates ?? {})) {
      const existing = this.predicateNames.get(name);
      if (existing) {
        throw new Error(
          `guard predicate already contributed by ${existing}: ${name} (names are global)`,
        );
      }
      this.predicateNames.set(name, manifest.id);
    }
    this.moduleIds.add(manifest.id);
    const ownOperations = new Set(Object.keys(registration.operations ?? {}));
    for (const name of manifest.withdraws ?? []) {
      if (ownOperations.has(name)) {
        throw new Error(
          `${manifest.id} withdraws its own operation: ${name} (a module cannot withdraw itself — just don't register it)`,
        );
      }
      this.withdrawn.set(name, manifest.id);
      this.operations.delete(name);
      this.operationEntitlement.delete(name);
    }
    for (const name of Object.keys(registration.operations ?? {})) {
      this.bindOperation(name);
      this.operationEntitlement.set(name, manifest.entitlementKey);
    }
  }

  defineOperation<I, O>(name: string, _handler: OperationHandler<I, O>): void {
    this.bindOperation(name);
  }

  private bindOperation(name: string): void {
    if (this.withdrawn.has(name)) return; // withdrawn by another manifest — never binds
    if (this.operations.has(name)) throw new Error(`operation already defined: ${name}`);
    this.operations.add(name);
  }

  // -- scope lifecycle ------------------------------------------------------

  async provisionScope(actor: PlatformActorId, input: ProvisionScopeInput): Promise<void> {
    // Shared with the pure adapter so the defaults cannot drift between them.
    const record = resolveScopeRecord(input);
    // Fail-closed tenant gate throws out of the awaited cp call BEFORE migrate
    // or audit, so a rejected provision creates nothing and writes no audit row.
    const created = await this.cp.provisionScope(
      input.tenantId,
      input.scopeId,
      record,
      new Date().toISOString(),
    );
    // Instantiate the scope DO and trigger its lazy migration.
    await this.migrateAndRecord(input.scopeId);
    // Audit a real provision only; an idempotent re-provision changed nothing.
    if (created) {
      await this.recordAdmin(
        actor,
        'provisionScope',
        { tenantId: input.tenantId, scopeId: input.scopeId, vertical: record.vertical },
        null,
        record,
      );
    }
  }

  /**
   * Migrate a scope and project its resulting migration count into the directory
   * (§5.4: fleet questions never fan out). The ScopeDO reports null when nothing
   * was pending, which skips the write — otherwise every stub mint would cost an
   * extra control-plane RPC to store a number that did not change.
   *
   * A failure is recorded and then RETHROWN (#32): the scope still fails closed,
   * but the directory learns which `module@version` broke and how many attempts it
   * has taken, instead of keeping a stale `schema_version` that renders as healthy.
   */
  private async migrateAndRecord(scopeId: ScopeId): Promise<void> {
    const stub = this.scopeStub(scopeId);
    try {
      const applied = await stub.migrate();
      if (applied !== null) await this.cp.setMigrationState(scopeId, String(applied), null);
    } catch (err) {
      // Best-effort: a scope that failed to migrate may also fail to answer, and a
      // broken recorder must not replace the migration error with its own — that
      // trades a diagnosable failure for a confusing one.
      try {
        const failure = await stub.migrationFailure();
        if (failure) {
          await this.cp.setMigrationState(scopeId, String(failure.applied), {
            version: failure.version,
            error: failure.error,
          });
        }
      } catch {
        // deliberately swallowed — the rethrow below is the real signal
      }
      throw err;
    }
  }

  async getScope(
    principal: PrincipalId,
    tenantId: TenantId,
    scopeId: ScopeId,
  ): Promise<ScopeStub> {
    // Lifecycle gates (control-plane.md §4.1/§4.2), the K-3 fail-closed path,
    // evaluated durably in the ControlPlaneDO. A throw propagates here.
    await this.cp.validateScopeAccess(tenantId, scopeId);

    const stub = this.scopeStub(scopeId);
    await this.migrateAndRecord(scopeId);
    const cp = this.cp;
    const operationEntitlement = this.operationEntitlement;

    return {
      tenantId,
      scopeId,
      invoke: async <O, I>(operation: string, input?: I): Promise<O> => {
        // Entitlement gate (§4.3): a module loads for a tenant only if the tenant
        // holds its SKU flag. Fails closed the same way withdrawal does.
        const requiredKey = operationEntitlement.get(operation);
        if (requiredKey && !(await cp.tenantHoldsEntitlement(tenantId, requiredKey))) {
          return Promise.reject(
            new Error(
              `operation not entitled: ${operation} — tenant does not hold '${requiredKey}'`,
            ),
          );
        }
        return stub.invoke(operation, input, principal, tenantId, scopeId) as Promise<O>;
      },
    };
  }

  async close(): Promise<void> {
    // Nothing to drain: every admin write awaits its RPC to completion inline.
  }

  // -- admin surface --------------------------------------------------------

  private buildAdmin(): HostAdmin {
    // The directory row → the `scope` contract. Parsed, not cast: the columns are
    // nullable in the DO's SQLite (ALTER TABLE cannot add NOT NULL to a populated
    // table) while the contract requires them, so this parse is where that gap is
    // held shut — and it is the same parse the pure adapter does, which is what
    // makes the shared contract suite meaningful.
    const mapOrg = (r: OrgRow): Org =>
      orgSchema.parse({
        id: r.org_id,
        tenantId: r.tenant_id,
        slug: r.slug,
        name: r.name,
        createdAt: r.created_at,
      });

    /**
     * Fail closed on an org that does not exist in this tenant. Scoped by tenant, not
     * just by id: an org from another tenant must read as absent, or grantToOrg would
     * reach across the boundary the record exists to make explicit.
     */
    const requireOrg = async (tenant: TenantId, id: OrgId): Promise<void> => {
      if (!(await this.cp.readOrg(tenant, id))) {
        throw new Error(`unknown org ${id} in tenant ${tenant}`);
      }
    };

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
        migrationFailure:
          r.migration_failed_version && r.migration_last_attempt_at
            ? {
                version: r.migration_failed_version,
                error: r.migration_error ?? '',
                attempts: r.migration_attempts,
                lastAttemptAt: r.migration_last_attempt_at,
              }
            : null,
        createdAt: r.created_at,
      });

    const transitionScope = async (
      actor: PlatformActorId,
      action: AdminAction,
      tenantId: TenantId,
      scopeId: ScopeId,
      from: ScopeStatus[],
      to: ScopeStatus,
    ) => {
      const before = await this.cp.transitionScope(tenantId, scopeId, from, to, action);
      // The audit target carries the scope's vertical (control-plane.md §4.4:
      // "vertical stays null until §4.2 lifecycle actions that name one"). The DO
      // returns it with the previous status, so the trail cannot disagree with
      // the directory about which deployment the action touched.
      await this.recordAdmin(
        actor,
        action,
        { tenantId, scopeId, vertical: before.vertical },
        { status: before.status },
        { status: to },
      );
    };

    const writeGrant = async (
      subject: string,
      permission: PermissionKey,
      node: Node,
      entity?: EntityRef,
      expiresAt?: string,
    ): Promise<void> => {
      if (entity) {
        await this.writeScopeTuple(
          node.scopeId!,
          subject,
          `granted:${permission}`,
          `${entity.entityType}:${entity.entityId}`,
          expiresAt ?? null,
        );
      } else if (node.scopeId) {
        await this.writeScopeTuple(
          node.scopeId,
          subject,
          `granted:${permission}`,
          `scope:${node.scopeId}`,
          expiresAt ?? null,
        );
      } else {
        await this.cp.writeTenantTuple(
          node.tenantId,
          subject,
          `granted:${permission}`,
          `tenant:${node.tenantId}`,
          expiresAt ?? null,
        );
      }
    };

    return {
      defineRole: async (actor, tenantId, role) => {
        const parsed = roleDefinition.parse(role);
        const before = await this.cp.defineRole(tenantId, parsed);
        await this.recordAdmin(actor, 'defineRole', { tenantId }, before, parsed);
      },
      listRoles: async (filter?: RoleFilter): Promise<TenantRole[]> => {
        const rows = await this.cp.listRoles({ tenantId: filter?.tenantId, source: filter?.source });
        // Parsed, not cast — the same parse the pure adapter does, which is what
        // makes the shared contract suite mean anything.
        return rows.map((r) =>
          tenantRole.parse({
            tenantId: r.tenant_id,
            key: r.role_key,
            permissions: JSON.parse(r.permissions),
            source: r.source,
          }),
        );
      },
      assignRole: async (actor, assignment: RoleAssignment) => {
        const subject = `principal:${assignment.principalId}`;
        if (assignment.node.scopeId) {
          await this.writeScopeTuple(
            assignment.node.scopeId,
            subject,
            `role:${assignment.roleKey}`,
            `scope:${assignment.node.scopeId}`,
            null,
          );
        } else {
          await this.cp.writeTenantTuple(
            assignment.node.tenantId,
            subject,
            `role:${assignment.roleKey}`,
            `tenant:${assignment.node.tenantId}`,
            null,
          );
        }
        await this.recordAdmin(
          actor,
          'assignRole',
          { tenantId: assignment.node.tenantId, scopeId: assignment.node.scopeId },
          null,
          assignment,
        );
      },
      grant: async (actor, grant: CapabilityGrant) => {
        await writeGrant(
          `principal:${grant.principalId}`,
          grant.permission,
          grant.node,
          grant.entity,
          grant.expiresAt,
        );
        await this.recordAdmin(
          actor,
          'grant',
          { tenantId: grant.node.tenantId, scopeId: grant.node.scopeId },
          null,
          grant,
        );
      },
      grantToOrg: async (actor, orgId, permission, node, entity) => {
        // The org must exist in the node's tenant. A grant to a phantom org looks
        // applied, resolves for nobody, and still shows up in the permission diff.
        await requireOrg(node.tenantId, orgId);
        await writeGrant(`org:${orgId}`, permission, node, entity);
        await this.recordAdmin(
          actor,
          'grantToOrg',
          { tenantId: node.tenantId, scopeId: node.scopeId },
          null,
          { orgId, permission, node, entity },
        );
      },
      createOrg: async (actor: PlatformActorId, input: CreateOrgInput) => {
        const parsed = createOrgInput.parse(input);
        const created = await this.cp.createOrg(
          parsed.id,
          parsed.tenantId,
          parsed.slug,
          parsed.name,
          new Date().toISOString(),
        );
        if (!created) return; // idempotent, and a no-op is not audited
        await this.recordAdmin(actor, 'createOrg', { tenantId: parsed.tenantId }, null, parsed);
      },
      listOrgs: async (tenantId: TenantId) => (await this.cp.listOrgs(tenantId)).map(mapOrg),
      getOrg: async (tenantId: TenantId, orgId: OrgId) => {
        const r = await this.cp.readOrg(tenantId, orgId);
        return r ? mapOrg(r) : undefined;
      },
      addMember: async (actor, tenantId, principal, orgId) => {
        await requireOrg(tenantId, orgId);
        await this.cp.writeTenantTuple(
          tenantId,
          `principal:${principal}`,
          'member',
          `org:${orgId}`,
          null,
        );
        await this.recordAdmin(actor, 'addMember', { tenantId }, null, { principal, orgId });
      },
      removeMember: async (actor, tenantId, principal, orgId) => {
        await requireOrg(tenantId, orgId);
        // Tombstone (K-21), never DELETE. The DO reports whether anything changed
        // so a repeat revoke stays a silent no-op rather than a second audit row.
        const changed = await this.cp.revokeMember(
          tenantId,
          `principal:${principal}`,
          `org:${orgId}`,
          new Date().toISOString(),
        );
        if (!changed) return;
        await this.recordAdmin(actor, 'removeMember', { tenantId }, { principal, orgId }, null);
      },
      listMembers: async (tenantId, orgId, options) => {
        await requireOrg(tenantId, orgId);
        const rows = await this.cp.listMembers(
          tenantId,
          `org:${orgId}`,
          options?.includeRevoked ?? false,
        );
        return rows.map((r) =>
          orgMembership.parse({
            principal: r.subject.slice('principal:'.length),
            orgId,
            revokedAt: r.revoked_at,
          }),
        );
      },
      createTenant: async (actor, input: CreateTenantInput) => {
        const parsed = createTenantInput.parse(input);
        const created = await this.cp.createTenant(
          parsed.id,
          parsed.slug,
          parsed.name,
          new Date().toISOString(),
        );
        // Idempotent: re-creating an existing tenant is a no-op, not audited.
        if (!created) return;
        await this.recordAdmin(actor, 'createTenant', { tenantId: parsed.id }, null, created);
      },
      setTenantStatus: async (actor, tenantId, status: TenantStatus) => {
        const before = await this.cp.setTenantStatus(tenantId, status);
        await this.recordAdmin(actor, 'setTenantStatus', { tenantId }, { status: before }, { status });
      },
      listTenants: async (): Promise<Tenant[]> =>
        (await this.cp.listTenants()).map((t) => tenantSchema.parse(t)),
      getTenant: async (tenantId): Promise<Tenant | undefined> => {
        const t = await this.cp.getTenant(tenantId);
        return t ? tenantSchema.parse(t) : undefined;
      },
      listScopes: async (filter?: ScopeFilter): Promise<Scope[]> => {
        const rows = await this.cp.listScopes({
          tenantId: filter?.tenantId,
          status: filter?.status
            ? Array.isArray(filter.status)
              ? filter.status
              : [filter.status]
            : undefined,
          vertical: filter?.vertical,
        });
        return rows.map(mapScope);
      },
      getScopeRecord: async (tenantId, scopeId): Promise<Scope | undefined> => {
        const row = await this.cp.getScopeRecord(tenantId, scopeId);
        return row ? mapScope(row) : undefined;
      },
      suspendScope: async (actor, tenantId, scopeId) =>
        transitionScope(actor, 'suspendScope', tenantId, scopeId, ['active'], 'suspended'),
      unsuspendScope: async (actor, tenantId, scopeId) =>
        transitionScope(actor, 'unsuspendScope', tenantId, scopeId, ['suspended'], 'active'),
      archiveScope: async (actor, tenantId, scopeId) =>
        transitionScope(actor, 'archiveScope', tenantId, scopeId, ['active', 'suspended'], 'archived'),
      unarchiveScope: async (actor, tenantId, scopeId) =>
        transitionScope(actor, 'unarchiveScope', tenantId, scopeId, ['archived'], 'active'),
      grantEntitlement: async (actor, tenantId, entitlementKey) => {
        const changed = await this.cp.grantEntitlement(tenantId, entitlementKey);
        if (!changed) return; // idempotent
        await this.recordAdmin(actor, 'grantEntitlement', { tenantId }, null, { entitlementKey });
      },
      revokeEntitlement: async (actor, tenantId, entitlementKey) => {
        const changed = await this.cp.revokeEntitlement(tenantId, entitlementKey);
        if (!changed) return; // nothing held, nothing changed
        await this.recordAdmin(actor, 'revokeEntitlement', { tenantId }, { entitlementKey }, null);
      },
      listEntitlements: async (tenantId): Promise<string[]> => this.cp.listEntitlements(tenantId),
      linkIdentity: async (actor, input: IdentityLink) => {
        const parsed = identityLink.parse(input);
        const changed = await this.cp.linkIdentity(
          parsed.provider,
          parsed.externalId,
          parsed.principal,
          parsed.tenantId,
          parsed.scopeId ?? null,
          new Date().toISOString(),
        );
        // Idempotent: an identity already bound is a no-op, not audited.
        if (!changed) return;
        await this.recordAdmin(
          actor,
          'linkIdentity',
          { tenantId: parsed.tenantId, scopeId: parsed.scopeId },
          null,
          { provider: parsed.provider, externalId: parsed.externalId, principal: parsed.principal },
        );
      },
      resolveIdentity: async (provider, externalId): Promise<ResolvedIdentity | undefined> => {
        const row = await this.cp.resolveIdentity(provider, externalId);
        if (!row) return undefined;
        return resolvedIdentity.parse({
          principal: row.principal,
          tenantId: row.tenantId,
          scopeId: row.scopeId,
        });
      },
      auditLog: async (filter?: AuditLogFilter): Promise<AdminLogEntry[]> => {
        const rows = await this.cp.auditLog({
          tenantId: filter?.tenantId,
          scopeId: filter?.scopeId,
          actor: filter?.actor,
          // Normalised to an array here so the DO has one shape to handle.
          action: filter?.action
            ? Array.isArray(filter.action)
              ? filter.action
              : [filter.action]
            : undefined,
          since: filter?.since,
          until: filter?.until,
          limit: filter?.limit,
          cursor: filter?.cursor,
          order: filter?.order,
        });
        return rows.map((r) => adminLogEntry.parse(r));
      },
    };
  }

  // -- helpers --------------------------------------------------------------

  private async recordAdmin(
    actor: PlatformActorId,
    action: AdminAction,
    target: { tenantId: TenantId; scopeId?: ScopeId | null; vertical?: string | null },
    before: unknown,
    after: unknown,
  ): Promise<void> {
    await this.cp.recordAdmin({
      id: ulid(),
      actor,
      action,
      tenantId: target.tenantId,
      scopeId: target.scopeId ?? null,
      vertical: target.vertical ?? null,
      before: before ?? null,
      after: after ?? null,
      at: new Date().toISOString(),
    });
  }

  private async writeScopeTuple(
    scopeId: ScopeId,
    subject: string,
    relation: string,
    object: string,
    expiresAt: string | null,
  ): Promise<void> {
    await this.scopeStub(scopeId).writeTuple(subject, relation, object, expiresAt);
  }

  private scopeStub(scopeId: ScopeId): ScopeStubRpc {
    // Deterministic DO id in milestone 1. Production mints per-jurisdiction ids
    // via newUniqueId (K-7) and stores the mapping in the directory — deferred.
    return this.scopeNs.get(this.scopeNs.idFromName(scopeId)) as unknown as ScopeStubRpc;
  }
}
