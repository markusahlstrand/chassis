# Callout (field service)

`demos/callout` — a small Swedish field-service firm (ElMontage AB, el/VVS installation): work
orders, technician time & material, checklists, and invoice basis. It is the platform's
**reference vertical** — the one a new vertical is built against.

## Overview

Callout is the **canonical composition** — the star-topology showpiece. It is where you see the
central claim of the platform work end to end: engines cooperating **through events and opaque
`EntityRef`s, with zero imports between them**. Complete a work order and, on the spine, an
invoice line appears — built by an engine that never imported the one that emitted the event.

Three things it demonstrates that the other demos build on:

- **The star topology, running.** Callout composes *three* engines — [`workorder`](/engines/workorder/),
  [`invoicing`](/engines/invoicing/), [`protocol`](/engines/protocol/) — and none imports another.
  `workorder.completed` lands on the spine; invoicing consumes it and builds billable lines by
  **snapshot, not join**, each with drill-down provenance. Editing time entries after completion is
  refused by the engine invariant — and wouldn't change the invoice line anyway, because it was
  snapshotted.
- **The pricing moment** — vertical logic meeting an engine transition in one transaction. The
  `callout/complete-workorder` operation runs the vertical's own compliance guard (a `montage`
  order needs a signed self-inspection protocol, via `requireSigned`), reads the engine-reported
  lines, prices them from the vertical's `callout_price_list` (min quantities, internal articles
  dropped), and *then* calls the engine's `completeWorkOrder(ctx, { billable })`. The engine
  invariant stays intact; pricing is 100% vertical-owned (K-16). Pricing is exactly the kind of
  thing an engine must never learn.
- **The protocol extraction, in place.** Callout's checklists began as vertical code and were
  extracted into the protocol engine at milestone B — a migration (`0003`) drops the old
  `callout_protocol_*` tables once the data moves into the engine's own. The extraction handoff
  is visible in the module.

## At a glance

| | |
|---|---|
| **Package** | `@substrat-run/demo-callout` |
| **Engines composed** | [`workorder`](/engines/workorder/) · [`invoicing`](/engines/invoicing/) · [`protocol`](/engines/protocol/) |
| **Own tables** | `callout_customers` · `callout_facilities` · `callout_price_list` |
| **Roles** | `office-admin` (15 keys) · `technician` (4 keys: `workorder:read`/`report`, `protocol:fill`/`read`) — portal customers hold no role, only an entity-narrowed `workorder:read` grant per customer |
| **Permission surface** | [`PERMISSIONS.md`](https://github.com/substrat-run/substrat/blob/main/demos/callout/PERMISSIONS.md) — 19 keys, 4 modules, 2 roles |
| **Apps** | node API (`:8871`) + React SPA (`:5271`), started together |
| **Status** | Working — the first **CP-less, sandbox-clean pushable** vertical, deployed on Cloudflare |

## The cast & what's denied

| Who | Holds | Cannot |
|---|---|---|
| **Anna** — kontor | `office-admin`, tenant level | — (runs the whole flow: create → assign → complete → export invoice basis) |
| **Harald** — tekniker | `technician` at the work scope | **assign** an order, complete it, or sign a protocol — he can only start jobs and report time/material |
| **Berit** — BRF Grunden portal customer | no role; entity-narrowed `workorder:read` on her org | see any order that isn't her org's — the portal walk is a **tuple proof-walk**, not a UI filter |
| **Styrbjörn** — another portal customer | the same, for his org | see Berit's orders |
| **Mallory** — office-admin of *another tenant* | `office-admin` in her own tenant | anything of ElMontage's — the cross-tenant denial |

Signing is deliberately kept from the technician: `protocol:fill` is not `protocol:sign`. Filling a
checklist and attesting it are different authorities, and the demo splits them.

## Deploying — the CP-less reference

Callout is the vertical the [deploy path](/guide/deploying) was proven on. Its `wrangler.jsonc`
declares only its **own** stores — its `SCOPE` Durable Object class and an `AUTH_DB` — and *no*
`CONTROL_PLANE` binding, no service binding, no platform secret: `assertSandboxContract` would
refuse an upload that reached for any of them. It evaluates permissions from its own storage
([scope-local permissions](/concepts/permissions#where-tuples-live-a-scope-reads-only-its-own-state))
and trusts the router-asserted node for tenancy. Its React SPA is **bundled into the worker** (a
build step generates `src/assets.ts`), so it needs no static-assets binding either. This is the
shape a self-serve vertical takes.

## Run it

```bash
pnpm callout-demo dev
# API  http://localhost:8871
# web  http://localhost:5271
```

The executable spec is `test/scenario.test.ts` — the nine-step headless scenario, including the
cross-tenant denial — plus `test/provision.test.ts` over the permission shape. On Cloudflare,
`cf:dev` runs it on local Durable Objects and `cf:deploy` ships it (Workers Paid plan for DO
SQLite); the same route table drives both, with only the adapter swapped SQLite ↔ DO/D1.

## Deliberately out of scope

Scheduling/dispatch (only an assignment field is shown), inventory, supplier invoices / EDI /
payroll, and a real Fortnox connector — export writes a stubbed file. The scheduling engine is a
[named next candidate](/engines/#engines-today), not a gap pretending to be filled.
