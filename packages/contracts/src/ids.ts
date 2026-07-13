import { z } from 'zod';

// Branded ID types: invalid states unrepresentable at the SDK boundary (§5.6/§5.8).
// ULIDs everywhere — sortable, opaque, no PII. IDs are logged outside jurisdictions
// by Cloudflare (billing/debug), so they must never encode meaning.

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export const tenantId = z.string().regex(ULID).brand<'TenantId'>();
export type TenantId = z.infer<typeof tenantId>;

export const scopeId = z.string().regex(ULID).brand<'ScopeId'>();
export type ScopeId = z.infer<typeof scopeId>;

export const principalId = z.string().regex(ULID).brand<'PrincipalId'>();
export type PrincipalId = z.infer<typeof principalId>;

export const eventId = z.string().regex(ULID).brand<'EventId'>();
export type EventId = z.infer<typeof eventId>;

export const dataSubjectId = z.string().regex(ULID).brand<'DataSubjectId'>();
export type DataSubjectId = z.infer<typeof dataSubjectId>;

// npm-package-shaped, e.g. '@chassis/engine-workorder'
export const moduleId = z
  .string()
  .regex(/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/)
  .brand<'ModuleId'>();
export type ModuleId = z.infer<typeof moduleId>;

// ISO 8601 with timezone (Z or offset). Stamped kernel-side, never caller-side.
export const instant = z.string().datetime({ offset: true }).brand<'Instant'>();
export type Instant = z.infer<typeof instant>;

// Module-namespaced permission key, e.g. 'workorder:create'
export const permissionKey = z
  .string()
  .regex(/^[a-z0-9-]+:[a-z0-9-]+$/)
  .brand<'PermissionKey'>();
export type PermissionKey = z.infer<typeof permissionKey>;

export const slug = z.string().regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);
