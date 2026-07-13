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
  schemaVersion: z.string(),
  createdAt: instant,
});
export type Scope = z.infer<typeof scope>;
