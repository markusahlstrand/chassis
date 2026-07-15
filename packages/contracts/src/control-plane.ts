import { z } from 'zod';
import { instant, platformActorId, scopeId, tenantId } from './ids.js';

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
]);
export type AdminAction = z.infer<typeof adminAction>;

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
