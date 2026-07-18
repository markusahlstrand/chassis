import { z } from 'zod';
import { instant, scopeId, slug, tenantId } from './ids.js';

export const tenantStatus = z.enum(['active', 'suspended', 'deleting']);
export type TenantStatus = z.infer<typeof tenantStatus>;

export const tenant = z.object({
  id: tenantId,
  slug,
  name: z.string().min(1),
  status: tenantStatus,
  createdAt: instant,
});
export type Tenant = z.infer<typeof tenant>;

// What the caller supplies to createTenant (control-plane.md §4.1); `status`
// (active) and `createdAt` are stamped host-side, never caller-supplied.
export const createTenantInput = tenant.pick({ id: true, slug: true, name: true });
export type CreateTenantInput = z.infer<typeof createTenantInput>;

export const scopeStatus = z.enum([
  'provisioning',
  'active',
  'suspended',
  'archiving',
  'archived',
]);
export type ScopeStatus = z.infer<typeof scopeStatus>;

// §5.2 of the design doc: A = DO-embedded SQLite is primary; B = DO control plane + D1
export const storageShape = z.enum(['A', 'B']);
export type StorageShape = z.infer<typeof storageShape>;

// Fixed at provisioning; a DO can never relocate (design K-7)
export const jurisdiction = z.enum(['eu']).nullable();
export type Jurisdiction = z.infer<typeof jurisdiction>;

/**
 * A scope's last *failed* migration attempt (kernel-design §5.3), or null when the
 * last attempt succeeded and when none has run.
 *
 * Migrations fail closed per scope: `applyPendingMigrations` rolls back and throws,
 * so the scope serves nothing. Before this record existed the directory learned
 * nothing from that — `schemaVersion` is projected only on the success path, so a
 * half-migrated scope kept a stale value and rendered as healthy.
 *
 * Deliberately **not** a `scopeStatus` member: the scope already fails closed at the
 * migration layer, so nothing about lifecycle gating changes, and the §3.3 machine
 * (`provisioning → active → suspended ⇄ active → archiving → archived`) has no
 * sensible transition for it. Structured rather than a flag because the
 * reconciliation sweep (§5.3) retries with backoff and reports
 * "487/500 migrated, 13 pending, 0 failed" — which needs the attempt count and the
 * failing version, not a boolean.
 *
 * `attempts` counts *consecutive* failures and resets to 0 on a successful apply.
 */
export const migrationFailure = z
  .object({
    version: z.string().min(1), // the `module@version` that threw
    error: z.string(),
    attempts: z.number().int().positive(), // ≥1: the record only exists after a failure
    lastAttemptAt: instant,
  })
  .nullable();
export type MigrationFailure = z.infer<typeof migrationFailure>;

export const scope = z.object({
  id: scopeId, // globally unique; APIs still take (tenantId, scopeId) and cross-check (K-3)
  tenantId,
  parentScopeId: scopeId.nullable(), // v1: always null; column ships so trees are additive (K-1)
  slug, // unique within tenant
  kind: z.string().min(1), // vertical vocabulary ('brf', 'filial'); kernel never branches on it
  name: z.string().min(1),
  status: scopeStatus,
  storageShape,
  jurisdiction,
  // Which vertical's deployment executes this scope (control-plane.md §1: the DO
  // class is the app binary). Nullable — a scope provisioned before the caller
  // names one, and the bare hosts in tests, carry null. It is what makes the
  // audit log's `vertical` target real for scope-lifecycle actions, and what
  // console item 1 means by "which vertical each scope runs".
  vertical: z.string().min(1).nullable(),
  // The scope's migration state: the count of applied (module, version) pairs,
  // as a string. Written host-side after migrations apply — never caller-supplied.
  // '0' means "provisioned, nothing applied yet". Comparing it against the host's
  // registered migration total is what answers §5.4's "which scopes are behind".
  schemaVersion: z.string(),
  migrationFailure,
  createdAt: instant,
});
export type Scope = z.infer<typeof scope>;
