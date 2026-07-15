import type {
  AdminLogEntry,
  CapabilityGrant,
  CreateTenantInput,
  Decision,
  DomainEvent,
  DomainEventInput,
  EntityRef,
  Jurisdiction,
  ModuleManifest,
  Node,
  PermissionKey,
  PlatformActorId,
  PrincipalId,
  RoleAssignment,
  RoleDefinition,
  ScopeId,
  StorageShape,
  Tenant,
  TenantId,
  TenantStatus,
} from '@substrat-run/contracts';

/**
 * The scope-host contract — the adapter seam (§5.1 of the design doc).
 *
 * Module code registers OPERATIONS; callers invoke them through a capability
 * stub. The operation handler runs INSIDE the scope's execution domain
 * (Durable Object on the Cloudflare adapter, per-scope actor locally), which is
 * what makes "one hop, then local queries" true in production and what makes
 * invariants enforceable: the handler sees sql/emit/check, the caller sees
 * only invoke().
 *
 * Contract semantics, pinned (K-6):
 * - Strict serialization per scope: one operation at a time, to completion.
 * - Structured-clone boundary: inputs and results are cloned even in-process;
 *   code can never share mutable state with a scope.
 */

export type SqlValue = string | number | bigint | Uint8Array | null;

export interface ScopedSql {
  query<T = Record<string, SqlValue>>(sql: string, params?: readonly SqlValue[]): T[];
  exec(sql: string, params?: readonly SqlValue[]): { changes: number };
}

/** What an operation handler sees — ambient tenancy, no IDs passed around (§7.8 of the plan). */
export interface OperationContext {
  readonly tenantId: TenantId;
  readonly scopeId: ScopeId;
  readonly principal: PrincipalId;
  readonly sql: ScopedSql;
  /** Envelope is stamped kernel-side (id, occurredAt, tenant, scope, actor); input is validated. */
  emit(event: DomainEventInput): void;
  /** Node-level check; pass `entity` for per-entity checks (portal access, §4.2 rule 3). */
  check(permission: PermissionKey, entity?: EntityRef): Promise<Decision>;
  /**
   * Record a relation tuple child→parent (K-16) — the write path for the
   * permission evaluator's entity-edge rule (design doc §4.2 rule 3). The
   * relation must be declared in some registered module's `entityRelations`.
   * Idempotent.
   */
  link(child: EntityRef, parent: EntityRef): void;
}

export type OperationHandler<I = unknown, O = unknown> = (
  ctx: OperationContext,
  input: I,
) => O | Promise<O>;

/** The capability stub — the ONLY way code outside the scope reaches it. */
export interface ScopeStub {
  readonly tenantId: TenantId;
  readonly scopeId: ScopeId;
  invoke<O = unknown, I = unknown>(operation: string, input?: I): Promise<O>;
}

export interface SqlMigration {
  /** Ordered, unique per module, e.g. '0001-init'. Journaled per (module, version). */
  version: string;
  sql: string;
}

/**
 * How a module (engine or vertical) joins a host: manifest + migrations +
 * operations in one registration. Migrations apply lazily per scope, inside
 * the scope's serialization domain, journaled in `_substrat_migrations`
 * (design doc §5.3 in miniature). Operations are the module's default
 * bindings (K-16); in-scope functions need no registration — they are plain
 * exports called by other modules' handlers.
 */
/**
 * Event consumers run as ordinary in-scope operations under a system actor,
 * delivered at-least-once (kernel delivery journal); handlers must be
 * idempotent. Ordering is guaranteed only within (scope, module) — K-11.
 */
export type ConsumerHandler = (ctx: OperationContext, event: DomainEvent) => void | Promise<void>;

/**
 * A named, manifest-wired pre-condition on an operation (K-17; engine-protocol
 * §6, open question 11). One module CONTRIBUTES a predicate under a name; a
 * (usually different) module's manifest WIRES it to an operation via
 * `guards: [{ before, predicate, config }]`. The kernel runs it inside the
 * guarded operation's own transaction, immediately before the handler:
 *
 *   throw  → the operation is BLOCKED and the transaction rolls back (fail closed)
 *   return → the handler runs
 *
 * `config` is the manifest's config object, opaque to the kernel and parsed by
 * the predicate itself; `input` is the (already structured-cloned) operation
 * input. A predicate is a READ: it must not mutate — it is a gate, not a hook.
 * Star topology holds — the guarded engine knows nothing of the guarding one.
 */
export type GuardPredicate = (
  ctx: OperationContext,
  config: Record<string, unknown>,
  input: unknown,
) => void | Promise<void>;

export interface ModuleRegistration {
  manifest: ModuleManifest;
  migrations?: SqlMigration[];
  operations?: Record<string, OperationHandler<never, unknown>>;
  /** eventType → handler; the types must appear in manifest.events.consumes. */
  consumers?: Record<string, ConsumerHandler>;
  /**
   * Named guard predicates this module contributes to the host — the code half
   * of `manifest.guards`. Names are module-namespaced like operations
   * ('protocol/all-signed'). Predicate names are global: two modules may not
   * contribute the same name.
   */
  predicates?: Record<string, GuardPredicate>;
}

/**
 * Admin surface for enforcement input (design doc §4; control-plane.md §4.4).
 *
 * Every mutation is a control-plane action: it takes a `PlatformActorId` — the
 * authenticated staff subject, typed distinctly from a tenant `PrincipalId` so
 * the compiler refuses to confuse them — and writes an append-only audit row
 * stamped platform-side (actor, action, target, before/after, timestamp). The
 * actor is never a principal in any tenant, and the record is never supplied by
 * the caller. This is the one surface that must not be retrofitted (K-20): a
 * surface that can act without a durable record of who acted is worse than none.
 *
 * Locally the actor is a dev stub (control-plane.md §6); real staff auth (SSO,
 * MFA) gates EXPOSING this surface, not building it — D-16 cashed in.
 */
export interface HostAdmin {
  defineRole(actor: PlatformActorId, tenantId: TenantId, role: RoleDefinition): void;
  assignRole(actor: PlatformActorId, assignment: RoleAssignment): void;
  grant(actor: PlatformActorId, grant: CapabilityGrant): void;
  /** Grant to an organization (portal customers); members reach it via membership tuples. */
  grantToOrg(
    actor: PlatformActorId,
    orgId: string,
    permission: PermissionKey,
    node: Node,
    entity?: EntityRef,
  ): void;
  addMember(actor: PlatformActorId, tenantId: TenantId, principal: PrincipalId, orgId: string): void;

  // -- tenant registry (control-plane.md §4.1) -------------------------------

  /**
   * Persist a tenant. Idempotent on the id — re-creating an existing tenant is a
   * no-op, not an error (control-plane.md §4.1). `status` starts `active` and
   * `createdAt` is stamped host-side. This is what replaces "a tenant is a ULID
   * nobody used before" with a real record.
   */
  createTenant(actor: PlatformActorId, input: CreateTenantInput): void;
  /**
   * Transition a tenant's status. `suspended` fails `getScope` closed for every
   * scope under the tenant (K-3's path) — the containment lever for non-payment
   * or an incident, reversible without deleting anything.
   */
  setTenantStatus(actor: PlatformActorId, tenantId: TenantId, status: TenantStatus): void;
  /** The tenant registry — the directory's inventory (control-plane.md §4.5 console item 1). */
  listTenants(): Tenant[];
  getTenant(tenantId: TenantId): Tenant | undefined;

  // -- scope lifecycle (control-plane.md §4.2) -------------------------------
  // The §3.3 transitions that existed only on paper. Each fails closed on an
  // illegal transition, is audited, and (for suspend/archive) makes getScope
  // fail closed for that scope. `provisionScope` is the entry transition and
  // lives on ScopeHost (it is async — it applies migrations).

  /** active → suspended. Reversible containment (incident, dispute). */
  suspendScope(actor: PlatformActorId, tenantId: TenantId, scopeId: ScopeId): void;
  /** suspended → active. */
  unsuspendScope(actor: PlatformActorId, tenantId: TenantId, scopeId: ScopeId): void;
  /** active|suspended → archived. Stops the active-scope meter (§9). */
  archiveScope(actor: PlatformActorId, tenantId: TenantId, scopeId: ScopeId): void;
  /**
   * archived → active. A RESTORE, never a flag flip (control-plane.md §4.2):
   * §9's meter can only charge on "active scope" if un-archiving is a deliberate,
   * audited act. Jurisdiction is untouched — it is fixed at provisioning (K-7).
   */
  unarchiveScope(actor: PlatformActorId, tenantId: TenantId, scopeId: ScopeId): void;

  // -- entitlements (control-plane.md §4.3) ----------------------------------
  // What finally makes `manifest.entitlementKey` mean something (D-20). An
  // entitlement is a per-tenant SKU flag; a module whose key the tenant does not
  // hold does not load for that tenant — its operations do not resolve, exactly
  // as if it had never been registered. Granting one is the point of the console.

  /** Turn a SKU flag on for a tenant. Idempotent; audited. */
  grantEntitlement(actor: PlatformActorId, tenantId: TenantId, entitlementKey: string): void;
  /** Turn it off. A tenant's scopes lose access to that module's operations. */
  revokeEntitlement(actor: PlatformActorId, tenantId: TenantId, entitlementKey: string): void;
  /** The tenant's held SKU flags (control-plane.md §5 meter 2). */
  listEntitlements(tenantId: TenantId): string[];

  /**
   * The append-only admin audit trail, newest-comparable last (ULID order is
   * chronological). Read path for the console history and the permission-diff
   * human checkpoint (control-plane.md §4.5).
   */
  auditLog(filter?: { tenantId?: TenantId }): AdminLogEntry[];
}

export interface ProvisionScopeInput {
  tenantId: TenantId;
  scopeId: ScopeId;
  storageShape?: StorageShape;
  jurisdiction?: Jurisdiction;
}

export interface ScopeHost {
  /**
   * Mint a capability stub for a principal. Validates the (tenantId, scopeId)
   * pair against the directory — a mismatched pair fails closed (K-3), it never
   * resolves to another tenant's scope.
   */
  getScope(principal: PrincipalId, tenantId: TenantId, scopeId: ScopeId): Promise<ScopeStub>;

  /**
   * The entry scope-lifecycle transition (control-plane.md §4.2): idempotent,
   * journaled, audited. Requires an existing ACTIVE tenant — a scope with no
   * tenant record is the "tenant is an FK string" hole §4.1 closes, so it fails
   * closed. Jurisdiction is fixed here forever (K-7).
   */
  provisionScope(actor: PlatformActorId, input: ProvisionScopeInput): Promise<void>;

  /** Enforcement-input writes: roles, assignments, grants, membership. */
  readonly admin: HostAdmin;

  /** Register a module: validates the manifest, applies migrations lazily per scope. */
  registerModule(registration: ModuleRegistration): void;

  /** Bare operation registration (tests, glue). Names are module-namespaced: 'workorder/create'. */
  defineOperation<I, O>(name: string, handler: OperationHandler<I, O>): void;

  close(): Promise<void>;
}
