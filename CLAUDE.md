# Substrat — agent conventions

Substrat is a hosted substrate for vertical business software: a multi-tenant kernel
(tenancy, permissions, events, migrations) + headless **engines** owning invariants +
**verticals** owning everything a user touches. Canonical docs: [docs/master-plan.md](docs/master-plan.md)
(strategy, decision log) and [docs/design/kernel-design.md](docs/design/kernel-design.md) (architecture).

## Layout

| Path | What | Published |
|---|---|---|
| `packages/contracts` | Zod schemas + branded IDs — the shared vocabulary | Apache-2.0 |
| `packages/kernel` | Scope-host contract, permission checker, ulid | AGPL + commercial |
| `packages/adapter-sqlite` | Pure-SQLite scope host (dev, CI, self-host, escrow) | AGPL + commercial |
| `packages/contract-tests` | Suites every adapter must pass | AGPL + commercial |
| `engines/*` | Domain engines (workorder, invoicing) | AGPL + commercial |
| `demos/*` | Demo verticals (ServiceCo = `demos/fsm`) | private, never published |
| `apps/docs` | Docs site | private |

## Commands

- `pnpm install` · `pnpm -r build` · `pnpm -r typecheck` · `pnpm test` (builds first)
- `node tools/boundary-lint.mjs` — the layer rules below, enforced mechanically (runs in CI)
- `pnpm fsm-demo dev` — run the ServiceCo demo (API :8787 + web :5173)
- One vitest scenario per demo vertical: `pnpm --filter @substrat-run/demo-fsm test`

## The three-layer rule (never violated)

1. **Kernel owns no domain entities.** It provides `OperationContext` (`ctx.sql`,
   `ctx.emit`, `ctx.check`, `ctx.link`), scope provisioning, roles/grants, migrations.
2. **Engines own invariants**: state machines that can't skip states, append-only
   entries, immutable-after-export, every mutation emits an event, every operation
   checks a permission. Engines never import other engines (**star topology**) —
   they cooperate via fat event payloads and opaque `EntityRef`s only.
3. **Verticals own vocabulary, pricing, screens, roles.** A vertical composes engine
   **in-scope functions** (plain exports like `createWorkOrder(ctx, …)`) inside its own
   operations — same transaction — and does the permission check itself. If a vertical
   needs to fork an engine, the engine drew its line wrong.

## Module code rules (mechanically linted)

Module code = everything reachable from a `ModuleRegistration` (operations, consumers).

- Data access is `ctx.sql` **only** — never import `better-sqlite3`, adapters, or
  `node:*` in module code. Harness code (`seed.ts`, `server.ts`, tests) is exempt.
- No `fetch`/network in module code; connectors handle the outside world.
- Never write to `_substrat_*` tables (reads for projections like timelines are fine —
  writes forge the spine).
- Every operation's first line: `assertAllowed(await ctx.check(PERM))`; per-entity
  checks (`ctx.check(perm, entityRef)`) for portal-style walks.
- Every mutation emits a **fat** event (consumer must never need a cross-module read);
  payload validated by the consumer's own Zod parse, never the producer's types.
- Migrations are append-only ordered `SqlMigration[]`; never edit a shipped version.
- IDs come from `ulid()`; money/decimals are strings via `@substrat-run/contracts`
  helpers (`moneyOf`, `mulMoney`, `addDecimal`, `compareDecimal`) — never floats.
- Parse, don't trust: operation inputs go through Zod schemas at the boundary.

## Two human checkpoints (agents never self-approve)

1. **Migration diff** — new/changed `SqlMigration[]` presented for review before merge.
2. **Permission diff** — new permission keys, role definitions, and grants presented
   as a readable table (key → description → which roles hold it).

Everything else the platform pushes back on mechanically: the typed SDK rejects invalid
states at compile time, `tools/boundary-lint.mjs` blocks raw access, contract tests and
the demo scenarios fail fast.

## Building a new vertical

Use the **new-vertical** skill (`.claude/skills/new-vertical/SKILL.md`). Reference
implementation: `demos/fsm` (spec in `demos/fsm/spec/`, module in `src/module.ts`,
world in `src/seed.ts`, scenario test in `test/scenario.test.ts`).
