# Modules & the manifest

Engines and verticals join a scope host the same way: as **modules**. A module is one
registration object bundling a manifest, migrations, operations, and event consumers:

```ts
import type { ModuleRegistration } from '@substrat/kernel';

const registration: ModuleRegistration = {
  manifest,      // self-describing metadata (validated Zod document)
  migrations,    // ordered SQL, journaled per module, applied lazily per scope
  operations,    // 'workorder/create' → handler
  consumers,     // 'workorder.completed' → handler
};

host.registerModule(registration);
```

## The manifest

The manifest is what makes a module **self-describing** — to the kernel that loads it,
to the app shell that renders it, and to the agents that build on it. It's a Zod-validated
document (`moduleManifest` in `@substrat/contracts`):

```ts
export const workorderManifest = moduleManifest.parse({
  id: '@substrat/engine-workorder',
  version: '0.0.1',
  kernelContract: '^0.0.1',          // semver range of the kernel API it targets
  permissions: [
    { key: 'workorder:create', description: 'Create work orders' },
    // ...
  ],
  events: {
    emits: [{ type: 'workorder.created', schemaVersion: 1 } /* ... */],
    consumes: [],
  },
  migrations: { journalDir: './migrations', compatibleFrom: '0.0.1' },
  attachmentTargets: [{ entityType: 'workorder', readPermission: 'workorder:read' }],
  entityRelations: [{ entityType: 'workorder', parentType: 'facility' }],
  entitlementKey: 'workorder',
  ui: { /* routes, nav, entityViews, widgets */ },
});
```

Field by field:

| Field | What it declares | Who consumes it |
|---|---|---|
| `id`, `version`, `kernelContract` | identity + the kernel API range this module targets | host, tooling |
| `permissions` | every key the module checks, with a description | permission review (the human-readable diff), admin UI, agents |
| `events.emits` / `events.consumes` | the module's event contract, schema-versioned | host wiring, compatibility checks, agents |
| `migrations` | journal location and `compatibleFrom` — the oldest schema this code tolerates (the skew window) | migration runner |
| `attachmentTargets` | entity types that accept attachments (documents, comments), and which permission gates reading them | kernel attachment services |
| `entityRelations` | parent edges (`workorder → facility`) that permission flows along | the [permission evaluator](/concepts/permissions) |
| `entitlementKey` | the SKU flag that gates loading this module for a tenant | entitlements / billing |
| `searchables` | entity types and fields registered for tenant-scoped search | search service |
| `ui` | routes, nav items, entity views, widgets — permission-keyed, composed into the vertical's app at build time | app shell |

Two fields deserve special mention:

- **`ui.entityViews`** is the cross-engine rendering mechanism: a module that stores an
  opaque `EntityRef` can render the entity's card by looking up the view registered for
  its `entityType` — no imports between engines.
- **`entitlementKey`** is how the module system turns commercial: enabling an engine for
  a tenant is flipping an entitlement, and the kernel refuses to load what isn't
  entitled.

## Migrations

Migrations are plain SQL, ordered and uniquely versioned per module:

```ts
migrations: [
  { version: '0001-init', sql: `CREATE TABLE workorder_orders ( ... );` },
]
```

Semantics:

- **Applied lazily per scope**, inside the scope's serialization domain, journaled in
  `_substrat_migrations` per (module, version). No global migration step; a scope
  migrates when it wakes.
- **Skew is a normal state.** With thousands of scopes, some will run the old schema for
  a window. `compatibleFrom` declares the oldest schema version the module's code
  tolerates; a reconciliation sweep wakes stragglers before the window closes.
- **Migrations are a human checkpoint.** They're deliberately plain SQL so review is
  review, not archaeology.

## Operations, consumers, and in-scope functions

- **`operations`** — the module's invokable surface, namespaced
  (`'workorder/create'`). Each default binding starts with its own permission check.
- **`consumers`** — event handlers keyed by event type; the types must appear in
  `manifest.events.consumes`. Idempotency required (at-least-once delivery).
- **In-scope functions** — plain exports (not registered anywhere) that a vertical's own
  operations can call to compose engine behavior in the same transaction. See
  [Operations & the scope host](/concepts/scope-host#in-scope-functions-vs-registered-operations).

## Attachment contracts and opaque refs

The kernel owns no entities, so everything generic binds to an opaque reference:

```ts
type EntityRef = { entityType: string; entityId: string };
```

Attachment contracts (documents, comments, activity, custom fields) attach to an
`EntityRef`; `attachmentTargets` declares which types accept them and which permission
gates access; `visibility` (`'internal' | 'customer'`) classifies every attachment item
so customer-portal exposure is a total, mandatory decision — like `piiClass`, a
classification only works if it was never optional.
