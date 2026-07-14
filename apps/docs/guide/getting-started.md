# Getting started

This walkthrough builds the smallest real thing: a scope host running on pure SQLite, a
module with a migration and one operation, and an invocation through a capability stub.
No cloud account, no services — one directory of `.sqlite` files.

::: warning Pre-release
Substrat is 0.x. The packages are developed in the
[substrat monorepo](https://github.com/substrat-run/substrat) and interfaces change
without notice until the first vertical ships.
:::

## Install

```sh
pnpm add @substrat-run/kernel @substrat-run/contracts @substrat-run/adapter-sqlite zod
```

`@substrat-run/adapter-sqlite` uses [better-sqlite3](https://www.npmjs.com/package/better-sqlite3),
a native module. With pnpm 10+, allow its build script:

```jsonc
// package.json
{
  "pnpm": {
    "onlyBuiltDependencies": ["better-sqlite3"]
  }
}
```

## 1. Create a host and provision a scope

```ts
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { UNSAFE_allowAllChecker } from '@substrat-run/kernel';
import { tenantId, scopeId, principalId } from '@substrat-run/contracts';

const host = new SqliteScopeHost({
  dir: './data', // one .sqlite file per scope + _directory.sqlite
  checker: UNSAFE_allowAllChecker, // omit for the secure default: deny everything
});

const tenant = tenantId.parse('01JZX6ZH2E8Q4W9T3M5N7P0R2S');
const scope = scopeId.parse('01JZX6ZH2EAB4CD9EF3GH5JK2M');

await host.provisionScope({ tenantId: tenant, scopeId: scope, jurisdiction: 'eu' });
```

Provisioning is idempotent and journaled. The `jurisdiction` is fixed at creation,
forever — data residency is a provisioning decision, not a runtime flag.

::: tip The checker choice is the security posture
`UNSAFE_allowAllChecker` grants everything to everyone and is named accordingly — use it
in tests and scratch scripts only. Omitting the checker gives you `denyAllChecker`:
nothing is allowed until you wire a real permission checker. See
[Permissions](/concepts/permissions).
:::

## 2. Register a module

A module is a manifest + migrations + operations. Here's a minimal one (engines ship
this structure for you — see [What is an engine?](/engines/)):

```ts
import { z } from 'zod';
import { moduleManifest } from '@substrat-run/contracts';
import { assertAllowed, ulid, type ModuleRegistration } from '@substrat-run/kernel';

const noteInput = z.object({ text: z.string().min(1) });

export const notesModule: ModuleRegistration = {
  manifest: moduleManifest.parse({
    id: '@acme/notes',
    version: '0.0.1',
    kernelContract: '^0.0.1',
    permissions: [
      { key: 'notes:write', description: 'Create notes' },
    ],
    events: {
      emits: [{ type: 'notes.created', schemaVersion: 1 }],
      consumes: [],
    },
    migrations: { journalDir: './migrations', compatibleFrom: '0.0.1' },
    attachmentTargets: [],
    entitlementKey: 'notes',
  }),
  migrations: [
    {
      version: '0001-init',
      sql: `CREATE TABLE notes (
        id         TEXT PRIMARY KEY,
        text       TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL
      );`,
    },
  ],
  operations: {
    'notes/create': async (ctx, input) => {
      assertAllowed(await ctx.check('notes:write' as never));
      const { text } = noteInput.parse(input);
      const id = ulid();
      ctx.sql.exec(
        'INSERT INTO notes (id, text, created_by, created_at) VALUES (?, ?, ?, ?)',
        [id, text, ctx.principal, new Date().toISOString()],
      );
      ctx.emit({
        type: 'notes.created',
        schemaVersion: 1,
        entity: { entityType: 'note', entityId: id },
        piiClass: 'none',
        payload: { noteId: id },
      });
      return { id };
    },
  },
};

host.registerModule(notesModule);
```

Things to notice:

- **The handler parses its input.** Zod at every trust boundary — "parse, don't trust".
- **The permission check is the first line.** `assertAllowed` throws `PermissionDenied`
  unless the decision is an allow.
- **`ctx.emit` takes no origin fields.** Tenant, scope, actor, id, and timestamp are
  stamped by the kernel; your code physically cannot mislabel an event.
- **Migrations apply lazily per scope**, journaled, inside the scope's serialization
  domain — you never run a migration step yourself.

## 3. Invoke through a stub

```ts
const principal = principalId.parse('01JZX6ZH2EXY4ZA9BC3DE5FG2H');

const stub = await host.getScope(principal, tenant, scope);
const { id } = await stub.invoke<{ id: string }>('notes/create', {
  text: 'first note',
});

await host.close();
```

`getScope` validates the `(tenantId, scopeId)` pair against the directory. A mismatched
pair **throws** — it never resolves to another tenant's scope, so a confused-deputy bug
in calling code fails closed instead of leaking data.

The stub is a capability: it carries the principal and the scope context, so the
operation handler receives ambient `ctx.tenantId` / `ctx.scopeId` / `ctx.principal` and
no IDs travel through your business logic.

## 4. Look at what happened

Scope databases are plain SQLite files in WAL mode — debugging is opening a file:

```sh
sqlite3 ./data/<scopeId>.sqlite 'SELECT * FROM notes;'
sqlite3 ./data/<scopeId>.sqlite 'SELECT type, tenant_id, actor, occurred_at FROM _substrat_events;'
```

The event row carries the full kernel-stamped envelope — that's your audit trail,
produced as a side effect of the write path rather than as something you remembered to
log.

## Next steps

- [Tenants & scopes](/concepts/tenancy) — the tenancy tree and how scopes are addressed.
- [Permissions](/concepts/permissions) — roles, grants, and proof-carrying decisions.
- [Events & audit](/concepts/events) — the envelope, PII classes, and consumers.
- [What is an engine?](/engines/) — using the work-order and invoicing engines instead
  of writing your own machinery.
- [@substrat-run/contract-tests](/reference/contract-tests) — if you're writing an adapter
  rather than a vertical.
