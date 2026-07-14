---
name: new-vertical
description: Scaffold a complete Substrat vertical (manifest, migrations, operations, seed world, server, app skin, scenario test) from a concept + the ServiceCo reference. Use when asked to build, scaffold, or skin a new vertical or demo vertical on the Substrat platform.
---

# Scaffold a Substrat vertical

A vertical is a private package under `demos/<name>/` that composes the published
engines with its own vocabulary, tables, pricing, roles, and screens. The reference
is **ServiceCo** (`demos/fsm`) — read these five files before writing anything:

1. `demos/fsm/src/module.ts` — manifest, migrations, operations, the pricing moment
2. `demos/fsm/src/seed.ts` — host construction, roles, grants, seed world
3. `demos/fsm/src/server.ts` — thin Hono wrapper, one route per operation
4. `demos/fsm/test/scenario.test.ts` — the headless end-to-end scenario
5. `packages/kernel/src/scope-host.ts` — the contract your module code runs against

Also load the repo rules in `CLAUDE.md` (three-layer rule, module code rules, the two
human checkpoints). The engines' surfaces are their `src/index.ts`:
`engines/workorder` (PERM, in-scope functions `createWorkOrder`/`getReportedLines`/
`listOrders`/`completeWorkOrder`, operations `workorder/*`) and `engines/invoicing`
(INVOICING_PERM, operations `invoicing/*`, consumes `workorder.completed`).

## Order of work

### 1. Spec first

Write `demos/<name>/spec/concept.md`: the firm, the cast (who does what, who must be
denied what), the vocabulary mapping onto engine entities (e.g. bike repairs = work
orders, mechanics = technicians), the vertical's own tables, and the scenario the
test will replay. Keep it one page. The vertical owns **vocabulary, extra fields,
price list, roles, screens** — nothing that belongs to an engine's state machine.

### 2. Package skeleton

Copy the shape of `demos/fsm/package.json`, `tsconfig.json`, `vitest.config.ts`.
Package name `@substrat-run/demo-<name>`, `"private": true`. Register the dev script
pass-through in the root `package.json` only if asked. Workspace globs already cover
`demos/*` and `demos/*/app`.

### 3. Module (`src/module.ts`)

- `moduleManifest.parse({...})`: id, version, `kernelContract: '^0.0.1'`, permission
  declarations (key + human description — these feed the permission diff), events
  emits/consumes, `attachmentTargets`, `entityRelations` (child → parent edges the
  permission walk follows, e.g. `bike → customer`), `entitlementKey`.
- Migrations: `SqlMigration[]`, tables prefixed `<name>_`, TEXT ids, ISO-8601 TEXT
  timestamps, decimal/money as TEXT. Append-only forever after.
- Operations: `OperationHandler<Input, Output>`; first line is always
  `assertAllowed(await ctx.check(...))`; validate inputs with Zod where they aren't
  already typed; `ctx.link(child, parent)` when creating entities with declared
  relations; compose engine in-scope functions for anything an engine owns
  (`createWorkOrder(ctx, …)` from your create operation, `getReportedLines` +
  `completeWorkOrder` from your pricing/completion operation).
- The **pricing moment** is the pattern to copy: read engine lines → apply the
  vertical's price list (min-qty, dropped internal articles, whatever the spec says)
  → call the engine's complete — one transaction, invariants intact.
- Portal listing: iterate entities and `ctx.check(perm, entityRef)` per entity — a
  proof walk, not UI filtering.
- Export a `ModuleRegistration` with namespaced operation names `'<name>/op-kebab'`.

### 4. World (`src/seed.ts`) and server (`src/server.ts`)

- `build<Name>Host(dir)`: `new SqliteScopeHost({ dir })` + `registerModule` for each
  engine and the vertical.
- Idempotent seed: provision scope(s), define roles **per tenant** from engine PERM +
  vertical permission keys, assign roles, create seed entities via `stub.invoke`
  (never raw SQL), entity-narrowed grants for portal principals, persist the cast to
  a JSON file so restarts reuse it.
- Server: dev principal picker via `x-principal` header, `getScope` → `invoke`, one
  route per operation, `PermissionDenied` → 403. **No business logic in routes.**

### 5. Scenario test (`test/scenario.test.ts`)

Replay the spec's scenario headlessly against a temp dir: migrations journaled →
lifecycle happy path → **denials hold** (wrong role, portal isolation between two
customers, cross-tenant attacker gets `unknown scope` / `permission denied`) →
pricing math exact to the öre → event consumed by invoicing (if used) → state
machine can't skip. Denial assertions are not optional — they are the demo.

### 6. App skin (`app/`)

Copy-and-own from `demos/fsm/app`: Vite + React, hash routing, principal picker in
the top bar, views renamed to the vertical's vocabulary. Change brand, labels, and
which columns matter; keep the api.ts pattern (typed wrappers over the server routes).

## Conventions the reference doesn't show

- **Permission keys** are host-local: two verticals never registered on the same host
  may reuse a key (`customer:manage`); rename only when the meaning differs. Roles are
  vertical vocabulary — name them for the persona (`workshop-admin`), don't copy the
  reference's role names.
- **Side-by-side demos**: pick the next free API port (fsm uses :8787, bike-shop :8788)
  and web port (:5173, :5174), and a vertical-specific localStorage key for the
  principal picker, so demos coexist.
- **Declare every link edge you traverse**: engines link the refs you hand them
  verbatim (workorder → your facility-shaped entity), and the adapter rejects links
  undeclared in any registered manifest — so your `entityRelations` must cover both
  your own edges (`bike → customer`) and the engine-made ones (`workorder → bike`).
  This is also exactly what makes the portal proof-walk reach the customer.

## Gates before you're done

Run all of these from the repo root; all must pass:

```bash
pnpm -r build && pnpm -r typecheck
node tools/boundary-lint.mjs
pnpm --filter @substrat-run/demo-<name> test
```

Then STOP and present the two human checkpoints — never merge past them yourself:

1. **Migration diff**: every new `SqlMigration` verbatim.
2. **Permission diff**: a table of new permission keys, descriptions, role
   definitions, and grants (who can now do what, and why).
