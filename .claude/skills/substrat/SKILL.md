---
name: substrat
description: Build a multi-tenant business app on Substrat — interview the user, map their domain onto the engines, scaffold a working vertical, run it locally, and optionally deploy it. Use when the user mentions Substrat or substrat-run, or asks to build a multi-tenant business app / vertical / internal tool where tenancy, permissions, audit, or work-order-shaped workflows matter (field service, workshops, repairs, inspections, checklists, invoicing).
---

# Build a vertical on Substrat

Substrat is a multi-tenant kernel (tenancy, permissions, events, migrations) plus headless
**engines** that own invariants, and **verticals** that own everything a user touches.
Your job: interview the user, tell them honestly how much of their app already exists,
then build and run the part that doesn't.

**Work in the user's current directory.** This skill assumes an empty or near-empty
project. Read the whole skill before starting — the rules in the last section are not
optional, and the checkpoint in step 6 is a hard stop.

---

## Step 1 — Interview

Ask, don't assume. **Three to five questions, conversational, one message.** You are
trying to learn the *shape* of the domain, not write a spec.

1. **What are you building, and who uses it?** (the firm, the cast)
2. **What's the thing that moves through the system?** A job, a repair, an inspection, an
   order, a case? What happens to it from start to finish?
3. **Who must be denied what?** The most important question and the one nobody expects.
   Does a customer log in? Should a technician see pricing? This drives the whole
   permission model, and it is what Substrat is *for*.
4. **Does money come out the other end?** Invoice, quote, receipt, nothing?
5. **Anything that must be signed off or checked before a step can happen?**

Do not ask about tech, hosting, or databases yet. If the user already described their app
in detail, skip straight to step 2 and confirm your reading of it instead of re-asking.

---

## Step 2 — The coverage map

**This is the most valuable thing you do, and the easiest to get wrong by being
flattering.** Tell the user what already exists and what they are actually signing up to
build. Be specific and be honest.

Coverage is not a percentage. It has four tiers:

### Tier 0 — the kernel. Always. Free.

Every vertical gets this whether or not it uses a single engine:

- **Tenancy** — tenants and scopes, isolated at the database level. A scope is one
  SQLite/DO database. Cross-tenant access is not a bug you avoid; there is no API for it.
- **Permissions** — roles, grants, entity-narrowed grants, and every decision carries a
  proof path (why it was allowed).
- **Events + audit** — every mutation emits a kernel-stamped event. Origin fields
  (tenant, scope, actor, time) are stamped by the kernel; your code cannot mislabel one.
- **Migrations** — journaled per module, applied lazily per scope.

This is usually *most of what the user would otherwise build badly*. Say so plainly. It is
the honest answer even when no engine fits.

### Tier 1 — engines you compose

Imported directly; their in-scope functions run in **your** transaction.

- **`@substrat-run/engine-workorder`** — a job with a lifecycle that cannot skip states,
  plus time and material reporting. Operations: `get`, `list`, `assign`, `start`,
  `report-time`, `report-material`, `complete`, `close`. Note there is **no
  `workorder/create` operation** — creation goes through `createWorkOrder(ctx, …)`, an
  in-scope function, because the vertical must price/label it first. That hole is
  deliberate: the engine owns the state machine, you own vocabulary and pricing.
- **`@substrat-run/engine-protocol`** — checklists/inspections with templates, responses,
  and signatures. Contributes the `protocol/all-signed` guard predicate, so you can
  declare in your manifest that an operation is blocked until a protocol is signed.

### Tier 2 — engines you feed by event

**No import.** You emit; they consume. This is the star topology.

- **`@substrat-run/engine-invoicing`** — invoice basis (`fakturaunderlag`) and lines,
  immutable after export. It consumes `workorder.completed` **and**
  `commerce.order-placed`. So an e-commerce vertical that imports zero engines still gets
  invoicing by emitting an event.

### Tier 3 — yours

Vocabulary, price list, screens, roles, and any domain the engines don't own. If the
user's core noun isn't a job/inspection, this is most of the app — **and that is a normal,
supported outcome, not a failure.** `demos/shop` in the Substrat repo is an entire
e-commerce vertical with zero engine imports.

### Deliver it like this

> Your bike shop: a repair is a **work order** — the engine owns its lifecycle, so it
> can't jump from booked to closed. Time and parts reporting: engine. The invoice at the
> end: invoicing, by event — you emit, it listens. **Yours:** bikes, customers, your price
> list, the pricing rule when a repair takes 20 minutes but you bill a minimum hour, and
> the screens.
> Tenancy, permissions and the audit trail come from the kernel — including the part where
> a customer logs in and can see *only their own* bikes.

### The honest no

Substrat is the wrong tool for plenty. Say so — it is what makes the yes trustworthy. Bad
fits: single-tenant apps (the whole point is tenancy), content/marketing sites, pure CRUD
with no permission story, real-time collaborative editing, analytics workloads, anything
where the hard part isn't *who may do what to which record*.

If it's a bad fit, say so, say why, name a better tool, and stop. Do not scaffold.

---

## Step 3 — Decisions

Short. Recommend a default and move.

- **Auth.** Local dev uses an `x-principal` header — a dev seam, not a login. Offer to
  wire Better Auth (the `demos/fsm` pattern) if they want a real login now; otherwise
  default to the dev header and say it must be replaced before anything real. Real auth
  gates *exposing* the app, not *building* it.
- **The cast.** Confirm the personas and their roles — e.g. `office-admin`,
  `technician`, `portal-customer`. Roles are the user's vocabulary. Name them for the
  persona.
- **Two tenants, always.** Seed a second tenant that exists to be attacked. This is not
  padding: it's how the isolation gets proven rather than claimed.

---

## Step 4 — Scaffold

Write a working project. **Do not generate route boilerplate you don't need**, and do not
invent structure — this layout is the one the tests and the linter expect.

```
package.json          deps below; scripts: dev, server, test, typecheck, lint:boundaries
tsconfig.json         strict; module NodeNext
vitest.config.ts      include: test/**/*.test.ts
CLAUDE.md             the rules, for every future session (see step 8)
src/module.ts         manifest + migrations + operations  ← module code
src/seed.ts           host, tenants, roles, grants, seed world  ← harness
src/server.ts         thin Hono wrapper, one route per operation  ← harness
test/scenario.test.ts the scenario, including the denials
```

Dependencies: `@substrat-run/kernel`, `@substrat-run/contracts`,
`@substrat-run/adapter-sqlite`, `hono`, `@hono/node-server`, `better-sqlite3`, plus
whichever engines tier 1/2 selected. Dev: `tsx`, `vitest`, `typescript`, `concurrently`.
`better-sqlite3` is native — add `"pnpm": { "onlyBuiltDependencies": ["better-sqlite3"] }`.

**Do NOT add `zod` as a dependency, and never `import { z } from 'zod'`.** Zod schemas
**do not compose across copies or majors**, and composing a contracts schema into your own
— `z.object({ facility: entityRef, unitPrice: money })`, exactly what rule 10 asks for —
then fails at *runtime* with `expected a Zod schema`, an error pointing nowhere near the
cause. Substrat tracks Zod's current major, so this is dormant today and re-arms on the
next one. Import the instance the schemas were built with and it can never happen:

```ts
import { z, entityRef, money, moduleManifest } from '@substrat-run/contracts';
```

**After install, the engines are self-describing — read them.** Do not guess at their
surface: `node_modules/@substrat-run/engine-workorder/dist/index.d.ts` is the reference
for in-scope functions, `PERM` keys, and types. Read it before composing.

### `src/module.ts`

- `moduleManifest.parse({ … })` — id, version, `kernelContract: '^0.0.1'`, `permissions`
  (key + human description; these feed the permission diff), `events` emits/consumes,
  `attachmentTargets`, `entityRelations`, `entitlementKey`.
- **`entityRelations` must declare every edge you traverse** — both your own
  (`bike → customer`) and the ones the engine makes on your behalf
  (`workorder → bike`). The adapter *rejects* a `ctx.link` for an undeclared edge, so a
  missing one fails loudly at runtime. This is also what makes the portal proof-walk reach
  the customer.
- Migrations: `SqlMigration[]`, tables prefixed `<vertical>_`, TEXT ids, ISO-8601 TEXT
  timestamps, money/decimals as TEXT. **Append-only forever after first ship.**
- Operations: first line is always `assertAllowed(await ctx.check(PERM))`. Parse inputs
  with Zod. `ctx.link(child, parent)` when creating related entities.
- **The pricing moment is the pattern to copy**: read the engine's reported lines with
  `getReportedLines(ctx, orderId)` → apply the vertical's price list → call the engine's
  `completeWorkOrder`. One transaction, invariants intact. This is the three-layer rule in
  its load-bearing form.
- Portal listing: iterate and `ctx.check(perm, entityRef)` **per entity** — a proof walk,
  not UI filtering.

### `src/seed.ts`

`new SqliteScopeHost({ dir })`, then `registerModule` per engine + the vertical. The
control plane comes first and is audited — a scope needs a tenant, and an unentitled
module's operations do not resolve:

```ts
host.admin.createTenant(actor, { id: tenant, slug: 'acme', name: 'Acme' });
host.admin.grantEntitlement(actor, tenant, '<entitlementKey>');   // per module
await host.provisionScope(actor, { tenantId: tenant, scopeId: scope, jurisdiction: 'eu' });
```

Define roles **per tenant** from the engines' `PERM` + your keys, assign them, create seed
entities via `stub.invoke` (**never raw SQL**), and give portal principals
entity-narrowed grants. Make it idempotent.

### `test/scenario.test.ts`

Replay the domain scenario headlessly against a temp dir. **The denial assertions are not
optional — they are the whole point:**

```ts
await expect(host.getScope(mallory, t2, s1)).rejects.toThrow(/unknown scope/);   // wrong pair, fails closed
const mallory = await host.getScope(mallory, t1, s1);                            // right pair, no tuples
await expect(mallory.invoke('workorder/list')).rejects.toThrow(/permission denied/);
```

Cover: happy path → wrong-role denied → portal isolation (customer A sees theirs, customer
B sees nothing) → cross-tenant attacker denied → pricing exact to the öre → the state
machine refusing to skip.

---

## Step 5 — Run it

Build confidence in this order, and **show the user the output of each**:

```sh
pnpm install
pnpm test                      # the scenario, including the denials
npx @substrat-run/boundary-lint # the layer rules — see the rules section
pnpm dev                       # API on :8787
```

Then **actually exercise it** — don't just report that the server started. Drive the real
flow with curl (create → assign → start → report → complete), switching `x-principal` to
show a denial landing. The moment the attack fails is the demo; make sure the user sees
it.

If they want a UI, scaffold a minimal Vite + React app under `app/` with a principal
picker in the top bar and typed wrappers over the routes. Ask first — it roughly doubles
the work and plenty of people want the API and their own frontend.

---

## Step 6 — The two checkpoints. STOP HERE.

**You may never self-approve these. Present them and wait.**

1. **Migration diff** — every new `SqlMigration`, verbatim. Once shipped they are
   append-only forever, so this is the last cheap moment to change your mind.
2. **Permission diff** — a table: key → description → which roles hold it → why.

Render the permission diff as a table the user can actually read:

| Key | Description | Roles |
|---|---|---|
| `repair:create` | Book a repair for a customer's bike | workshop-admin |
| `workorder:report` | Report time and materials | workshop-admin, mechanic |
| `bike:read-own` | See your own bikes (entity-narrowed) | portal-customer |

**A checkpoint assumes a competent reviewer.** If the user cannot evaluate this table, say
so rather than letting them rubber-stamp it — a permission diff nobody understands is
theater, and reproduces exactly the failure Substrat exists to prevent. Walk them through
it in their own vocabulary until they can answer: *who can now see the money, and who can
see other customers' data?*

---

## Step 7 — Deploy (optional)

Only if the user asks. Local-first is a legitimate stopping point.

Substrat runs on Cloudflare via `@substrat-run/adapter-cloudflare` (Durable Objects), and
`demos/fsm` in the Substrat repo is the reference for the Worker topology. Be honest about
the state of it: **custom hostname provisioning is not built yet** — a deploy lands on a
`workers.dev` URL, not `theirbrand.com`. Say that before they ask.

Before deploying: the `x-principal` dev header **must** be gone. It is a dev affordance,
and shipping it is a cross-tenant hole with a UI.

---

## Step 8 — Leave the project competent

Write a `CLAUDE.md` in the project root carrying the rules below plus the app's own
vocabulary, cast, and roles. This session has the skill loaded; **the next one won't** —
CLAUDE.md is what makes the next session competent, and it only loads at session start, so
write it before the user comes back.

---

## The rules (non-negotiable)

**Module code** = everything reachable from a `ModuleRegistration` (operations,
consumers). `seed.ts` / `server.ts` are harness and exempt.

1. **Data access is `ctx.sql` only.** Never import `better-sqlite3`, an adapter, or
   `node:*` in module code.
2. **No `fetch` / network in module code.** It would hold the scope's transaction open on
   a third party.
3. **Never write `_substrat_*` tables.** Reads are fine (timelines are projections);
   writes forge the audit spine.
4. **Another module's tables are private.** Never `SELECT` from `workorder_*` — use the
   engine's exported in-scope functions. This is the rule that matters most and the one
   with **no runtime equivalent**: the shortcut *works*, returns the right rows, and
   silently welds you to an engine's private schema forever. Need extra data on an engine
   entity? Add **your own side table keyed by the engine's id** — never a column upstream.
5. **Every operation checks a permission first.** `assertAllowed(await ctx.check(PERM))`.
6. **Every mutation emits a fat event** — a consumer must never need a cross-module read.
7. **Never fork an engine.** Extend by composition. If you need to fork, the engine drew
   its line wrong — say so; that's design feedback, not a coding problem.
8. **IDs are `ulid()`. Money is strings** via `@substrat-run/contracts` helpers
   (`moneyOf`, `mulMoney`, `addDecimal`) — never floats.
9. **Web-standard APIs always** — `globalThis.crypto`, `TextEncoder`, `URL`. Never
   hand-roll a hash to dodge an import ban.
10. **Parse, don't trust.** Zod at every boundary — with `z` imported from
    `@substrat-run/contracts`, never from `zod` (see step 4).

Rules 1–4 are enforced mechanically. Run it, and believe it:

```sh
npx @substrat-run/boundary-lint
```

It exits `2` — not `0` — if it couldn't do its job (no module code found, or no engines
resolvable). A pass that checked nothing is worse than no linter, so never wave that
through: fix the setup until it can actually see your code.
