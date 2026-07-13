import { z } from 'zod';
import {
  dataSubjectId,
  eventId,
  instant,
  moduleId,
  principalId,
  scopeId,
  tenantId,
} from './ids.js';

// Opaque ref — the kernel owns no entities (D-1); attachment contracts bind here.
export const entityRef = z.object({
  entityType: z.string().min(1),
  entityId: z.string().min(1),
});
export type EntityRef = z.infer<typeof entityRef>;

// Drives crypto-shredding (§5.3 of the plan). Required at the type level:
// an event that COULD carry PII cannot be declared without classification.
export const piiClass = z.enum(['none', 'pseudonymous', 'direct']);
export type PiiClass = z.infer<typeof piiClass>;

// 'workorder.completed' — module-namespaced
export const eventType = z.string().regex(/^[a-z0-9-]+\.[a-z0-9-]+$/);

export const systemActor = z.object({ system: moduleId });
export const actor = z.union([principalId, systemActor]);
export type Actor = z.infer<typeof actor>;

const piiInvariant = (
  val: { piiClass: PiiClass; subjectId?: unknown },
  ctx: z.RefinementCtx,
): void => {
  if (val.piiClass !== 'none' && val.subjectId === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['subjectId'],
      message: `subjectId is required when piiClass is '${val.piiClass}' — crypto-shredding must be able to key the erasure`,
    });
  }
};

// What module code passes to emit(). Everything identifying the origin is
// deliberately absent — the kernel stamps it (§6.1 of the design doc).
export const domainEventInput = z
  .object({
    type: eventType,
    schemaVersion: z.number().int().positive(),
    entity: entityRef,
    piiClass,
    subjectId: dataSubjectId.optional(),
    payload: z.unknown(),
  })
  .superRefine(piiInvariant);
export type DomainEventInput = z.infer<typeof domainEventInput>;

// The full envelope as it enters the spine.
export const domainEvent = z
  .object({
    id: eventId, // ULID; idempotency key downstream (consumers are required-idempotent)
    type: eventType,
    schemaVersion: z.number().int().positive(),
    occurredAt: instant, // stamped by kernel
    tenantId, // stamped by kernel — a vertical cannot mislabel an event's origin
    scopeId, // stamped by kernel
    actor, // stamped by kernel from the stub's ambient context
    entity: entityRef,
    piiClass,
    subjectId: dataSubjectId.optional(),
    payload: z.unknown(),
  })
  .superRefine(piiInvariant);
export type DomainEvent = z.infer<typeof domainEvent>;
