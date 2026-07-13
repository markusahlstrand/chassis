# FSM demo — implementation spec for the pure-SQLite test run

Status: draft v0.1 · Last updated: 2026-07-13

> Companion to [concept.md](concept.md) (the concept) and
> [kernel-design.md](../../../docs/design/kernel-design.md) (the contracts). This document is the
> implementation-level spec: concrete schemas, operations, events, permissions, and the
> scenario script — detailed enough to build and run end-to-end on
> `@chassis/adapter-sqlite` with **no UI, no HTTP, no Cloudflare** — and to derive the
> **minimum kernel API surface** (§9) the run requires.

## 1. Goal and non-goals

**Goal.** A vitest-driven scenario (§8) exercising the full loop: provision → modules
load → work order lifecycle → priced completion → event → invoicing line → portal
isolation → cross-tenant attack fails. Everything observable in plain `.sqlite` files.

**Non-goals for this run:** UI (§7.4 composes later against the same operations — the
individual views are specified in [views.md](views.md)), HTTP surface
(zod-openapi wraps the same operations later), protocols engine, scheduling, Tier 2,
notifications, documents, custom fields, offline, Cloudflare adapter.

## 2. Cast

- Tenant **ElMontage AB** (`t1`) — scope **Stockholm** (`s1`).
- Tenant **RörService AB** (`t2`) — scope **Göteborg** (`s2`). Exists to be attacked.
- Principals: `anna` (office-admin, t1 tenant-level), `harald` (technician, role @ s1),
  `berit` (portal user at customer *BRF Grunden*, entity-narrowed grant),
  `styrbjörn` (portal user at customer *Kontorshotellet*, proves portal isolation),
  `mallory` (office-admin at **t2** — the attacker).

## 3. Modules and ownership

| Package | Owns | Namespace |
|---|---|---|
| `engines/workorder` | orders + time + material (one engine, D-19) | `workorder_*`, ops `workorder/*` |
| `engines/invoicing` | fakturaunderlag | `invoicing_*`, ops `invoicing/*` |
| `demos/fsm` (`@chassis-demos/fsm`, private) | customers, facilities, price list, orchestration | `serviceco_*`, ops `serviceco/*` |

Workspace: `demos/*` in `pnpm-workspace.yaml`. Demo verticals live under `demos/`
(one folder per demo, more over time — `demos/bikeshop` is next); the engines stay
top-level `engines/*` because they are product seeds shared across demos, not demo
material.

## 4. Data model (DDL as shipped in module migrations)

### 4.1 `demos/fsm` (vertical) — migration 0001

```sql
CREATE TABLE serviceco_customers (
  id          TEXT PRIMARY KEY,          -- ULID
  number      TEXT NOT NULL UNIQUE,      -- '1001'
  name        TEXT NOT NULL,
  org_ref     TEXT,                      -- 'org:<ulid>' — the authhero org (§4.3), nullable
  created_at  TEXT NOT NULL
);

CREATE TABLE serviceco_facilities (
  id          TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES serviceco_customers(id),
  name        TEXT NOT NULL,
  address     TEXT,
  access_note TEXT,                      -- door codes; visibility: internal (K-13)
  created_at  TEXT NOT NULL
);

CREATE TABLE serviceco_price_list (
  article      TEXT PRIMARY KEY,         -- 'labor', 'travel-km', 'mat:fan-motor-15w'
  description  TEXT NOT NULL,
  unit         TEXT NOT NULL,            -- 'tim', 'km', 'st'
  price_amount TEXT NOT NULL,            -- Money decimal string (K-14)
  currency     TEXT NOT NULL DEFAULT 'SEK',
  min_qty      TEXT,                     -- survey: minimum billable quantity
  internal     INTEGER NOT NULL DEFAULT 0  -- survey: restid is non-billable
);
```

Declared `entityRelations` (vertical manifest): `facility → customer`.
FK within the module is fine (rule §7.3.1); no FK crosses a module boundary.

### 4.2 `engines/workorder` — migration 0001

```sql
CREATE TABLE workorder_orders (
  id            TEXT PRIMARY KEY,
  number        INTEGER NOT NULL UNIQUE, -- scope-local sequence (MAX+1, safe: serialized)
  facility_type TEXT NOT NULL,           -- EntityRef columns — opaque to the engine
  facility_id   TEXT NOT NULL,
  customer_type TEXT NOT NULL,           -- denormalized by the caller (see §6: fat events);
  customer_id   TEXT NOT NULL,           --   the engine never resolves facility→customer
  kind          TEXT NOT NULL,           -- vertical vocabulary: 'service', 'akut', …
  title         TEXT NOT NULL,
  description   TEXT,
  status        TEXT NOT NULL CHECK (status IN
                  ('planned','in_progress','completed','closed')),
  assigned_to   TEXT,                    -- PrincipalId
  created_by    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  completed_at  TEXT
);

-- Append-only: the engine registers no update/delete operation, and the
-- contract tests assert none exists. Corrections (survey: "8 (+2) tim") are
-- future append-rows with a delta, not v0.
CREATE TABLE workorder_time_entries (
  id          TEXT PRIMARY KEY,
  order_id    TEXT NOT NULL REFERENCES workorder_orders(id),
  technician  TEXT NOT NULL,             -- PrincipalId
  hours       TEXT NOT NULL,             -- decimal string
  note        TEXT,
  reported_at TEXT NOT NULL
);

CREATE TABLE workorder_material_lines (
  id          TEXT PRIMARY KEY,
  order_id    TEXT NOT NULL REFERENCES workorder_orders(id),
  article     TEXT NOT NULL,             -- vertical price-list key; opaque here
  qty         TEXT NOT NULL,
  note        TEXT,
  reported_by TEXT NOT NULL,
  reported_at TEXT NOT NULL
);
```

Declared `entityRelations`: `workorder → facility`.

**State machine (engine invariant):** `planned → in_progress → completed → closed`;
no skips, no reverse. `report-time`/`report-material` allowed in
`planned | in_progress`; `complete` requires `in_progress`; everything rejects on
`completed | closed` (immutability after completion — the survey's accounting
semantics). Closing is separate from completing so the protocol-gate (open question 11)
has a place to attach later.

### 4.3 `engines/invoicing` — migration 0001

```sql
CREATE TABLE invoicing_underlag (
  id            TEXT PRIMARY KEY,
  number        INTEGER NOT NULL UNIQUE,
  customer_type TEXT NOT NULL,           -- EntityRef, from the event payload
  customer_id   TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('open','exported')),
  created_at    TEXT NOT NULL,
  exported_at   TEXT
);

-- Snapshot, not join (§7.3 discussion): prices/quantities frozen at completion,
-- provenance kept as EntityRef columns.
CREATE TABLE invoicing_lines (
  id                TEXT PRIMARY KEY,
  underlag_id       TEXT NOT NULL REFERENCES invoicing_underlag(id),
  source_type       TEXT NOT NULL,       -- 'workorder'
  source_id         TEXT NOT NULL,
  article           TEXT NOT NULL,
  description       TEXT NOT NULL,
  qty               TEXT NOT NULL,
  unit              TEXT NOT NULL,
  unit_price_amount TEXT NOT NULL,
  currency          TEXT NOT NULL,
  line_total_amount TEXT NOT NULL,
  created_at        TEXT NOT NULL
);
```

Consumer idempotency is kernel-managed via the delivery journal (§9.3); the engine's
invariant on top: an `exported` underlag is immutable — late redeliveries open a *new*
underlag rather than mutating an exported one.

## 5. Operations

All operations run in-scope (K-10) with `ctx = { tenantId, scopeId, principal, sql,
emit, check, link }` (`link` is new — §9.2). Inputs/outputs are Zod schemas in each
module's package; every operation starts with `await ctx.check(...)`.

### 5.1 `demos/fsm` (vertical operations)

| Operation | Permission | Behavior |
|---|---|---|
| `serviceco/create-customer` `{number, name, orgRef?}` → `Customer` | `customer:manage` | insert; `ctx.link('customer:<id>' → scope)` root |
| `serviceco/create-facility` `{customerId, name, address?, accessNote?}` → `Facility` | `facility:manage` | insert; `ctx.link('facility:<id>' → 'customer:<id>')` |
| `serviceco/create-workorder` `{facilityId, kind, title, description?}` → `WorkOrder` | `workorder:create` | resolves facility→customer (own tables), then **calls the engine's in-scope function** `createWorkOrder(ctx, {facility, customer, …})` (§9.1) |
| `serviceco/complete-workorder` `{orderId}` → `{order, billable}` | `workorder:complete` | **the pricing moment**: reads the engine's time/material via engine read-function, prices each line from `serviceco_price_list` (min-qty applied, internal lines dropped), then calls engine `completeWorkOrder(ctx, {orderId, billable})` — pricing is vertical logic (§3 of the plan), the invariant is the engine's, one transaction |
| `serviceco/list-portal-orders` `{}` → `WorkOrder[]` | `workorder:read` (entity-narrowed) | lists orders whose customer the caller's grant reaches — exercises the tuple walk |

### 5.2 `engines/workorder`

| Operation / function | Permission | Invariant enforced |
|---|---|---|
| `workorder/get` `{orderId}` | `workorder:read` | — (per-entity check via proof walk) |
| `workorder/list` `{status?}` | `workorder:read` | — |
| `workorder/assign` `{orderId, technician}` | `workorder:assign` | status `planned`; emits `workorder.assigned` |
| `workorder/start` `{orderId}` | `workorder:report` | `planned → in_progress`; emits `workorder.started` |
| `workorder/report-time` `{orderId, hours, note?}` | `workorder:report` | status ∈ planned/in_progress; append-only; emits `workorder.time-reported` |
| `workorder/report-material` `{orderId, article, qty, note?}` | `workorder:report` | same |
| `workorder/close` `{orderId}` | `workorder:close` | `completed → closed`; emits `workorder.closed` |
| *fn* `createWorkOrder(ctx, input)` | caller checked | insert as `planned`; `ctx.link('workorder:<id>' → 'facility:<id>')`; emits `workorder.created` |
| *fn* `completeWorkOrder(ctx, {orderId, billable})` | caller checked | `in_progress → completed`; validates billable lines against reported quantities; stamps `completed_at`; emits `workorder.completed` (fat payload, §6) |
| *fn* `getReportedLines(ctx, orderId)` | caller checked | read API for the pricing step |

The engine registers `workorder/*` operations as default bindings of these functions;
the vertical composes the functions inside its own operations when it needs to wrap
them (K-16).

### 5.3 `engines/invoicing`

| Operation / consumer | Permission | Behavior |
|---|---|---|
| `invoicing/list-underlag` `{status?}` | `invoicing:read` | — |
| `invoicing/get-underlag` `{underlagId}` → underlag + lines | `invoicing:read` | — |
| `invoicing/export` `{underlagId}` | `invoicing:export` | `open → exported`, immutable after; emits `invoicing.underlag-exported` |
| *consumer* `on workorder.completed@1` | (system) | find-or-create `open` underlag for `payload.customer`; insert one line per billable entry with provenance `EntityRef{workorder, orderId}`; emits `invoicing.underlag-updated` |

## 6. Events (fat payloads — the consumer must never need a cross-module read)

| Type | v | piiClass | Payload |
|---|---|---|---|
| `workorder.created` | 1 | none | `{orderId, number, facility: EntityRef, customer: EntityRef, kind, title}` |
| `workorder.assigned` | 1 | pseudonymous → `subjectId` = technician | `{orderId, technician}` |
| `workorder.started` | 1 | none | `{orderId}` |
| `workorder.time-reported` | 1 | pseudonymous → technician | `{orderId, entryId, hours}` |
| `workorder.completed` | 1 | none | `{orderId, number, facility, customer, billable: BillableLine[], total: Money}` |
| `workorder.closed` | 1 | none | `{orderId}` |
| `invoicing.underlag-updated` | 1 | none | `{underlagId, addedLines, source: EntityRef}` |
| `invoicing.underlag-exported` | 1 | none | `{underlagId, number, total: Money}` |

`BillableLine = {article, description, qty, unit, unitPrice: Money, lineTotal: Money,
sourceType: 'time'|'material', sourceId}`. v0 note: `subjectId` for technicians reuses
the principal ULID as `DataSubjectId` — a principal↔subject registry is a later kernel
concern; the envelope contract is exercised regardless.

## 7. Permissions

**Keys** (declared in manifests): `customer:manage`, `facility:manage`,
`workorder:create|read|assign|report|complete|close`, `invoicing:read|export`.

**Roles** (vertical-defined): `office-admin` = all of the above; `technician` =
`workorder:read`, `workorder:report`.

**Setup tuples (via kernel admin surface, §9.4):**
- `anna` → role `office-admin` @ (t1, null) — inherits into s1 (rule 2).
- `harald` → role `technician` @ (t1, s1).
- `berit` → capability grant `workorder:read` @ (t1, s1) **entity `customer:brf-grunden`**.
- `styrbjörn` → same shape at `customer:kontorshotellet`.

**The walk the run must prove** (D-23 rule 3): berit reads order `X` ⇔
`workorder:X parent facility:F` (linked by engine) → `facility:F parent customer:G`
(linked by vertical) → grant(`workorder:read`, entity=`customer:G`) → **allow, with
that chain as the proof**. Same check against styrbjörn's order → deny.

## 8. The scenario script (vitest, in order)

1. **Provision**: two hosts? No — one host, two tenants, one scope each; register all
   three modules; migrations apply on first `getScope` (assert `_chassis_migrations`
   rows per module).
2. **Seed**: roles/assignments/grants (§7); customers *BRF Grunden* + *Kontorshotellet*
   with one facility each; price list (`labor` 515/tim min 1.5, `travel-km` 6/km
   internal, `mat:fan-motor-15w` 1150/st).
3. **Lifecycle**: anna creates WO at BRF Grunden's facility ("Droppar vatten från
   frysen", kind `akut`) → assert `workorder.created` in outbox, number = 1, status
   `planned`, parent tuple written. Anna assigns harald; harald starts; harald reports
   1.0 h (+ later 0.75 h) and one fan motor.
4. **Denials that must hold**: harald tries `assign` → deny (proof-less); mallory
   (t2 admin) calls `getScope(t2, s1)` → **throws** (K-3 pair check), and with the
   correct pair `(t1, s1)` she mints a stub but holds no tuples in t1 — every
   operation denies at the owning scope's evaluation (enforcement is per-operation,
   not stub possession); berit tries `workorder/report` → deny; anna reports time on
   a *completed* order later → engine throws.
5. **Priced completion**: anna runs `serviceco/complete-workorder` → labor billed at
   min-qty 1.75 h? no — 1.75 > 1.5 min ⇒ 1.75 × 515; travel dropped (internal);
   material 1 × 1150. Assert `workorder.completed` payload totals; order immutable
   afterwards (further `report-time` throws).
6. **Star topology observed**: dispatcher delivers → assert `invoicing_underlag` for
   customer BRF Grunden exists with 2 lines, provenance `workorder:<id>`, snapshot
   prices; **redeliver the same event manually → no duplicate lines** (delivery journal
   + engine invariant).
7. **Portal isolation**: berit `serviceco/list-portal-orders` → exactly her order, and
   the decision's proof is the 3-tuple chain; styrbjörn → empty list; berit
   `invoicing/list-underlag` → deny (no grant).
8. **Export immutability**: anna exports the underlag; a second completion for the same
   customer opens a **new** underlag.
9. **The files**: open `t1__s1.sqlite` in any SQLite browser — the demo's escrow beat,
   asserted here as "tables exist and are readable read-only".

Every assertion above that touches kernel behavior (journal, delivery, proof paths,
fail-closed) graduates into `@chassis/contract-tests` as a generic harness; the
FSM-specific ones stay in the vertical's own `test/`.

## 9. Minimum kernel surface — the deliverable

### 9.1 Already built (no work)

`ScopeHost.getScope/provisionScope/defineOperation` · `ScopeStub.invoke` ·
`OperationContext.sql/emit/check` · outbox with kernel-stamped envelopes ·
strict serialization + clone boundary · fail-closed pair check · contracts schemas
(incl. manifest `entityRelations`/`ui`, money, visibility, tuples/proofs).

### 9.2 To build — kernel/adapter (the actual gap list)

1. **Module registration + migration journal.**
   `host.registerModule({ manifest, migrations: SqlMigration[], operations, functions,
   consumers })` — validates the manifest, namespaces operations, and applies pending
   migrations per scope on first `getScope` (journaled per `(module_id, version)`;
   crash-safe; the design's §5.3 in miniature).
2. **`ctx.link(child: EntityRef, parent: EntityRef)`** — writes a relation tuple,
   validated against the manifest's declared `entityRelations`. The write path for
   D-23 rule 3. (Contract addition — K-16.)
3. **Local event dispatch.** After an operation commits, the host drains new outbox
   rows to registered consumers *in the same scope*, at-least-once, recorded in a
   kernel `_chassis_deliveries (event_id, consumer_module)` journal; consumer handlers
   run as ordinary in-scope operations (system actor). Redelivery on crash; consumers
   idempotent by contract.
4. **Tuple permission checker v0** behind the existing `PermissionChecker` seam:
   `_chassis_tuples` in scope storage; the four fixed derivations (role expansion,
   tree inheritance via tenant-level assignments, declared entity edges depth≤4,
   membership); proof-path decisions; `explain`.
5. **Kernel admin surface** for enforcement input: `defineRole`, `assignRole`,
   `grant` (incl. entity-narrowed), `addMember` — host-level in v0 (the human-checkpoint
   review path wraps these later, §4.5).
6. **In-scope function composition** (K-16): engines export plain functions taking
   `ctx`; a vertical operation may call them — same transaction, same serialization,
   invariants intact because everything still flows through `ctx`. Registered
   operations are default bindings of these functions. (Mostly a documented pattern +
   type exports; no runtime machinery.)

### 9.3 Explicitly NOT needed for this run

HTTP surface (zod-openapi) · SDK package · shell/UI · Cloudflare adapter · Tier 2 /
query gateway · documents/attachments service · notifications · search · jobs/cron ·
WFP/routing · identity adapter (principals are literals in the test) · entitlement
gating (all modules entitled).

The run therefore measures the honest minimum: **items 1–5 in §9.2 are the entire
distance between today's green scaffold and a running FSM.**

## 10. Build order

1. Kernel deltas §9.2 (1) registration+journal, (3) dispatch, (4) checker, (5) admin,
   (2) `ctx.link` — with contract-test harnesses added per item.
2. `engines/workorder` (schemas → migrations → functions/ops → own tests).
3. `engines/invoicing` (+ consumer; redelivery test).
4. `demos/fsm` (+ the §8 scenario as its test suite).
5. Promote generic assertions into `@chassis/contract-tests`.

## 11. Open items surfaced by this spec

- Order/underlag **numbering**: scope-local MAX+1 is safe under serialization but
  per-module — is a shared kernel sequence service wanted? (v0: per-module.)
- `subjectId` ↔ principal registry (§6 note) — kernel concern, post-run.
- Corrections as append-only deltas (survey pattern) — workorder engine v2.
- Where `serviceco/list-portal-orders` filters: v0 filters in the operation via proof
  walks per row (N small); the general answer (permission-aware list queries) is a
  query-layer design task flagged for the checker's v1.
