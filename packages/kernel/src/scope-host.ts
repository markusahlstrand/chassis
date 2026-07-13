import type {
  Decision,
  DomainEventInput,
  Jurisdiction,
  PermissionKey,
  PrincipalId,
  ScopeId,
  StorageShape,
  TenantId,
} from '@chassis/contracts';

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
  check(permission: PermissionKey): Promise<Decision>;
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

  /** Module registration: operation names are module-namespaced, e.g. 'workorder/create'. */
  defineOperation<I, O>(name: string, handler: OperationHandler<I, O>): void;

  close(): Promise<void>;
}
