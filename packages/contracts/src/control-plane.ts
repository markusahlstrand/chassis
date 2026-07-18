import { z } from 'zod';
import { instant, orgId, platformActorId, principalId, scopeId, tenantId } from './ids.js';

// The control plane — the shared layer across N per-vertical deployments (D-30,
// control-plane.md). This file carries the audit contract that every effecting
// mutation writes; the tenant registry, lifecycle, and entitlement store land in
// later slices (control-plane.md §4.1–4.3).

// One row per control-plane mutation. Extended additively as §4.2/§4.3 add
// lifecycle and entitlement actions (new enum members are additive — D-28).
export const adminAction = z.enum([
  'defineRole',
  'assignRole',
  'grant',
  'grantToOrg',
  'addMember',
  'removeMember', // K-21 — tombstones the membership tuple, never deletes it
  'createOrg', // K-22 — orgs are a real record, not a free-form string
  'createTenant', // §4.1
  'setTenantStatus', // §4.1 — before/after carry the transitioned status
  'provisionScope', // §4.2 — the first scope-lifecycle transition (→ active)
  'suspendScope', // §4.2
  'unsuspendScope', // §4.2
  'archiveScope', // §4.2
  'unarchiveScope', // §4.2 — an explicit restore, never a silent flag flip
  'grantEntitlement', // §4.3 — the SKU flag turned on for a tenant
  'revokeEntitlement', // §4.3
  'linkIdentity', // D-16 — bind an external identity to a principal
]);
export type AdminAction = z.infer<typeof adminAction>;

/**
 * The neutral identity seam (D-16; control-plane.md §6 "principal derivation").
 * An auth adapter at the edge (Better Auth, an OIDC issuer, …) authenticates a
 * user and maps its external identity to a Substrat principal + home node. The
 * kernel never learns HOW a caller authenticated, only WHO they are — the
 * mechanism stays a swappable adapter. Authentication only: authorization is
 * roles/grants, and `provider` keeps N adapters (and OIDC upstreams) distinct.
 */
export const identityLink = z.object({
  provider: z.string().min(1), // 'better-auth' | 'oidc:<issuer>' | …
  externalId: z.string().min(1), // the provider's stable user id (e.g. the OIDC `sub`)
  principal: principalId,
  tenantId,
  scopeId: scopeId.optional(), // omitted = tenant-level home
});
export type IdentityLink = z.infer<typeof identityLink>;

export const resolvedIdentity = z.object({
  principal: principalId,
  tenantId,
  scopeId: scopeId.nullable(),
});
export type ResolvedIdentity = z.infer<typeof resolvedIdentity>;

/**
 * One principal's membership of one org, as the directory holds it (K-21).
 *
 * `revokedAt` non-null is a **tombstone**: the tuple is still here and still
 * readable, and the permission walk skips it. Deletion is not an option — an
 * operated compliance product has to show both that access was revoked and the
 * trail proving it was once granted (D-32), and a deleted row shows neither.
 *
 * Listing defaults to live members only; revoked rows are the evidence view.
 */
export const orgMembership = z.object({
  principal: principalId,
  orgId,
  revokedAt: instant.nullable(),
});
export type OrgMembership = z.infer<typeof orgMembership>;

/**
 * An append-only admin audit row (control-plane.md §4.4). Every field except
 * `before`/`after` is stamped platform-side — never supplied by the caller —
 * for the same reason the kernel is trusted at all (K-4): a surface that can act
 * without a durable record of who acted is worse than no surface.
 *
 * `target` is `(tenantId, scopeId?, vertical?)`. `scopeId`/`vertical` are null
 * for tenant-wide actions; `vertical` stays null until §4.2 lifecycle actions
 * (provision/suspend) that name one.
 */
export const adminLogEntry = z.object({
  id: z.string().min(1), // ULID, stamped host-side; sortable = chronological
  actor: platformActorId,
  action: adminAction,
  tenantId,
  scopeId: scopeId.nullable(),
  vertical: z.string().nullable(),
  before: z.unknown().nullable(), // prior state where cheaply readable (e.g. a redefined role)
  after: z.unknown().nullable(), // the applied payload
  at: instant,
});
export type AdminLogEntry = z.infer<typeof adminLogEntry>;
