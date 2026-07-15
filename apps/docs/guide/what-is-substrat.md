# What is Substrat?

Substrat is a substrate for building **vertical B2B SaaS** — the software a property
manager, an installation firm, or a point-of-sale chain actually runs their business on.

AI has made building that kind of software fast and cheap — except for the parts that
were never about writing code: multi-tenancy, identity, permissions, integrations, data
integrity, audit, and GDPR. Those are exactly the parts that are catastrophic when wrong,
and the parts LLM-generated code gets wrong most often.

Substrat owns those hard parts and enforces them **at runtime**, so small teams — including
non-engineers wielding AI tools — can build production-grade products on top, at AI speed,
without the speed being fatal.

> We build the substrate. You build the verticals.

## The three layers

Everything in Substrat hangs off one decomposition:

### 1. Kernel

Everything that is true of *every* B2B SaaS, and nothing that is true of any particular
one: identity, nested tenancy, permissions, events/audit, the module system, GDPR
machinery.

The kernel owns **no domain entities** — there is no customer table and no work-order
table in the kernel. Instead it offers *attachment contracts* (events, permissions,
documents, relations) that bind to opaque `(entityType, entityId)` references your code
defines. Your domain stays yours; the guarantees stay the kernel's.

### 2. Engines

Domain machinery shared across verticals but too domain-shaped for the kernel: work
orders, invoicing, scheduling, ticketing. Engines are headless, versioned npm packages
that register into the kernel like any other module.

Engines own **invariants**: state machines can't skip states, time entries are
append-only, exported invoices are immutable, every mutation emits an event, every access
passes the permission check. Verticals own everything with a user's fingerprints on it:
vocabulary, extra fields, triggers, pricing logic, UI.

The design test for the boundary: *if a vertical ever needs to fork an engine, the engine
drew its line wrong.*

See [What is an engine?](/engines/) for the composition rules and the engines that exist
today.

### 3. Verticals

The actual products — your code. A vertical composes the kernel and one or more engines,
adds its own module (schema, operations, screens), and ships. Verticals are where AI
tools do their best work, because the layer where LLMs are strongest (screens, forms,
workflows, reports) is the layer where mistakes are cosmetic — the catastrophic layer
sits below the API surface, enforced by the kernel.

## What "enforced at runtime" means concretely

Code built on Substrat **cannot**:

- **reach another tenant's data** — data access only exists as capability-scoped
  operations invoked through a stub minted for one `(tenant, scope)` pair; a mismatched
  pair fails closed rather than resolving to someone else's data;
- **skip the audit log** — events are stamped with tenant, scope, actor, and timestamp
  *below* the API surface; calling code cannot forge, suppress, or mislabel them;
- **emit unclassified PII** — every event carries a mandatory `piiClass`, and a
  PII-classed event without a data-subject key fails validation, so GDPR erasure is
  always possible;
- **bypass the permission model** — operations run inside the scope's execution domain
  and check permissions there, and every allow carries the proof path that granted it.

None of this depends on the discipline of the code above it — which is the point, because
increasingly that code is written by an agent.

## Current status

Substrat is pre-release (0.x). What exists today:

| Piece | Package | Status |
|---|---|---|
| Contract schemas (Zod, source of truth) | [`@substrat-run/contracts`](/reference/contracts) | Working |
| Kernel interfaces (scope host, permission checker) | [`@substrat-run/kernel`](/reference/kernel) | Working |
| Pure-SQLite scope host (local dev, CI, self-host) | [`@substrat-run/adapter-sqlite`](/reference/adapter-sqlite) | Working |
| Adapter conformance suite | [`@substrat-run/contract-tests`](/reference/contract-tests) | Working |
| Cloudflare scope host (Durable Objects, production) | [`@substrat-run/adapter-cloudflare`](/reference/adapter-cloudflare) | Working — same suite, real workerd |
| Work-order engine | [`@substrat-run/engine-workorder`](/engines/workorder) | Seed |
| Invoicing engine | [`@substrat-run/engine-invoicing`](/engines/invoicing) | Seed |
| Protocol / checklist engine | [`@substrat-run/engine-protocol`](/engines/protocol) | Seed |
| ServiceCo vertical — runs on both adapters, deployed on Cloudflare | [`demos/fsm`](https://github.com/substrat-run/substrat/tree/main/demos/fsm) | Working |

Interfaces change without notice until the first vertical ships.
