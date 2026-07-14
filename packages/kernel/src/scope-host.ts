import type {
  CapabilityGrant,
  Decision,
  DomainEvent,
  DomainEventInput,
  EntityRef,
  Jurisdiction,
  ModuleManifest,
  Node,
  PermissionKey,
  PrincipalId,
  RoleAssignment,
  RoleDefinition,
  ScopeId,
  StorageShape,
  TenantId,
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
 * Admin surface for enforcement input (design doc §4; testrun spec §9.2.5).
 * v0 is host-level; the human-checkpoint review workflow wraps this later.
 */
export interface HostAdmin {
  defineRole(tenantId: TenantId, role: RoleDefinition): void;
  assignRole(assignment: RoleAssignment): void;
  grant(grant: CapabilityGrant): void;
  /** Grant to an organization (portal customers); members reach it via membership tuples. */
  grantToOrg(orgId: string, permission: PermissionKey, node: Node, entity?: EntityRef): void;
  addMember(tenantId: TenantId, principal: PrincipalId, orgId: string): void;
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

  /** Idempotent; journaled. Jurisdiction is fixed here forever (K-7). */
  provisionScope(input: ProvisionScopeInput): Promise<void>;

  /** Enforcement-input writes: roles, assignments, grants, membership. */
  readonly admin: HostAdmin;

  /** Register a module: validates the manifest, applies migrations lazily per scope. */
  registerModule(registration: ModuleRegistration): void;

  /** Bare operation registration (tests, glue). Names are module-namespaced: 'workorder/create'. */
  defineOperation<I, O>(name: string, handler: OperationHandler<I, O>): void;

  close(): Promise<void>;
}
