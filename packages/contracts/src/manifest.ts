import { z } from 'zod';
import { moduleId, permissionKey } from './ids.js';
import { eventType } from './events.js';

// The manifest is what makes a module self-describing — to agents now, to
// strangers buying it later (§5.6 of the plan, §7.1 of the design doc).

export const semverVersion = z
  .string()
  .regex(/^\d+\.\d+\.\d+(-[0-9A-Za-z-.]+)?(\+[0-9A-Za-z-.]+)?$/);

export const permissionDeclaration = z.object({
  key: permissionKey,
  description: z.string().min(1), // fuel for the human-readable permission diff (§4.3)
});
export type PermissionDeclaration = z.infer<typeof permissionDeclaration>;

export const eventTypeRef = z.object({
  type: eventType,
  schemaVersion: z.number().int().positive(),
});
export type EventTypeRef = z.infer<typeof eventTypeRef>;

export const moduleManifest = z.object({
  id: moduleId, // '@substrat/engine-workorder'
  version: semverVersion,
  kernelContract: z.string().min(1), // semver range of the kernel API it targets
  permissions: z.array(permissionDeclaration),
  events: z.object({
    emits: z.array(eventTypeRef),
    consumes: z.array(eventTypeRef), // star topology: consumes types, never siblings (D-19)
  }),
  migrations: z.object({
    journalDir: z.string().min(1), // Drizzle journal location within the package
    compatibleFrom: z.string().min(1), // skew window: oldest schema this code tolerates
  }),
  attachmentTargets: z.array(
    z.object({
      entityType: z.string().min(1),
      readPermission: permissionKey, // attachment access checks the owning entity's key
    }),
  ),
  // Declared entity parent edges, e.g. workorder → facility. Permission flows
  // along these in the tuple evaluator's fixed algebra (design doc §4.2 rule 3,
  // depth-capped) — how entity-narrowed grants resolve.
  entityRelations: z
    .array(
      z.object({
        entityType: z.string().min(1), // 'workorder'
        parentType: z.string().min(1), // 'facility'
      }),
    )
    .optional(),
  entitlementKey: z.string().regex(/^[a-z0-9-]+$/), // the SKU flag that gates loading (D-20)
  api: z.string().optional(), // path to emitted OAS for the HTTP surface, if any (D-22)
  searchables: z
    .array(
      z.object({
        entityType: z.string().min(1),
        fields: z.array(z.string().min(1)).min(1),
      }),
    )
    .optional(),
  // UI contributions, composed into the vertical's app at BUILD time by the
  // shell (design doc §7.4, K-15). Component values are module-relative import
  // paths. All contributions are permission-keyed; the shell renders them
  // permission-aware from the proof-path checker.
  ui: z
    .object({
      routes: z
        .array(z.object({ path: z.string().min(1), screen: z.string().min(1), permission: permissionKey }))
        .optional(),
      nav: z
        .array(
          z.object({
            label: z.string().min(1), // i18n key
            icon: z.string().optional(),
            to: z.string().min(1),
            permission: permissionKey,
          }),
        )
        .optional(),
      // the EntityRef → view registry: cross-engine rendering without imports
      entityViews: z
        .array(z.object({ entityType: z.string().min(1), view: z.string().min(1) }))
        .optional(),
      widgets: z
        .array(z.object({ slot: z.string().min(1), component: z.string().min(1), permission: permissionKey }))
        .optional(),
      settingsPanels: z
        .array(z.object({ label: z.string().min(1), component: z.string().min(1), permission: permissionKey }))
        .optional(),
    })
    .optional(),
});
export type ModuleManifest = z.infer<typeof moduleManifest>;
