import { z } from 'zod';
import { instant, moduleId, permissionKey, principalId, scopeId, tenantId } from './ids.js';
import { entityRef } from './events.js';

// ============================================================================
// Authored surface — what humans and agents write (design doc §4.1).
// ============================================================================

// A node in the assignable tree: tenant root (scopeId null) or a scope.
export const node = z.object({
  tenantId,
  scopeId: scopeId.nullable(),
});
export type Node = z.infer<typeof node>;

export const roleKey = z.string().regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);

export const roleDefinition = z.object({
  key: roleKey,
  permissions: z.array(permissionKey).min(1),
  // Who declared this role. Both members mean "declared in CODE" — an engine's
  // manifest or a vertical's provisioning constants. There is deliberately no
  // value for "an operator created this against a live deployment": nothing can
  // create one yet (role writes are not on the control-plane HTTP surface), and
  // an enum member no code path can produce is the same promise-with-no-mechanism
  // this codebase keeps finding. It lands with whatever writes it.
  source: z.union([moduleId, z.literal('vertical')]),
});
export type RoleDefinition = z.infer<typeof roleDefinition>;

/**
 * A role as the directory holds it — the definition plus the tenant it belongs
 * to (control-plane.md §4.5's roles surface). `RoleDefinition` is what a caller
 * AUTHORS, and a tenant is ambient at that point (`defineRole(actor, tenantId,
 * role)`); this is what a caller READS back, where the tenant is the answer to
 * "where does this role apply?" and has to travel with it.
 */
export const tenantRole = roleDefinition.extend({ tenantId });
export type TenantRole = z.infer<typeof tenantRole>;

export const roleAssignment = z.object({
  principalId,
  roleKey,
  node,
});
export type RoleAssignment = z.infer<typeof roleAssignment>;

// Narrow, direct, time-boxable; also the cross-tenant mechanism (§5.4).
// `entity` narrows the grant to one entity and its declared descendants —
// how portal customers see only their own facilities/orders inside a shared
// scope (design doc §4.1, K-12). Always audited.
export const capabilityGrant = z.object({
  principalId,
  permission: permissionKey,
  node,
  entity: entityRef.optional(),
  expiresAt: instant.optional(),
  grantedBy: principalId,
});
export type CapabilityGrant = z.infer<typeof capabilityGrant>;

// ============================================================================
// Evaluation representation — relationship tuples (design doc §4.2, plan D-23).
// Internal to the checker; verticals never author these. The fixed derivation
// algebra (role expansion, tree inheritance, declared entity parent edges,
// membership) lives in the evaluator, not in configurable rewrites.
// ============================================================================

// 'principal:<ulid>' | 'org:<ulid>' | 'tenant:<ulid>' | 'scope:<ulid>' |
// '<entityType>:<entityId>' — namespace:id
export const objectRef = z
  .string()
  .regex(/^[a-z0-9_-]+:[^\s]+$/)
  .brand<'ObjectRef'>();
export type ObjectRef = z.infer<typeof objectRef>;

// 'member' | 'parent' | 'role:staff' | 'granted:workorder:read' …
export const relationName = z.string().regex(/^[a-z0-9_:-]+$/);

export const relationTuple = z.object({
  subject: objectRef,
  relation: relationName,
  object: objectRef,
});
export type RelationTuple = z.infer<typeof relationTuple>;

// ============================================================================
// Decisions — an allow ALWAYS carries its proof: the tuple chain that granted
// access. Powers explain(), "view as user" (§7.8), and the human-readable
// permission diff. An unexplained allow is unrepresentable.
// ============================================================================

export const decision = z.discriminatedUnion('allowed', [
  z.object({
    allowed: z.literal(true),
    proof: z.array(relationTuple).min(1),
  }),
  z.object({
    allowed: z.literal(false),
    checked: permissionKey,
    node,
  }),
]);
export type Decision = z.infer<typeof decision>;

export const effectivePermissions = z.object({
  principalId,
  node,
  permissions: z.array(
    z.object({
      permission: permissionKey,
      proof: z.array(relationTuple).min(1),
    }),
  ),
});
export type EffectivePermissions = z.infer<typeof effectivePermissions>;
