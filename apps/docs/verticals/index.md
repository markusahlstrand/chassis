# What is a vertical?

A **vertical** is the business: the software a service firm, a workshop, a shop, or an HR
team actually runs on. It owns everything with a user's fingerprints on it — **vocabulary,
pricing, roles, screens, workflows** — and it composes the [engines](/engines/) and the
kernel underneath.

Where an engine is a reusable *contract*, a vertical is a *composition plus a product*. It
is where the three layers meet: the kernel's guarantees, the engines' invariants, and the
business's own logic, wired together in one place you can read.

## What a vertical owns (and what it borrows)

- **Borrows invariants** from engines by calling their in-scope functions inside its *own*
  operations — same transaction, so an engine's state machine and the vertical's own tables
  commit together or not at all.
- **Does its own permission check** as the first line of every operation; engines never
  decide who may call a vertical.
- **Adds side tables keyed by an engine's ids** when it needs extra data on an engine
  entity — never a column upstream (a module's tables are private).
- **Owns the screens** — the app is the vertical's, composed over one API; the kernel and
  engines ship headless.

The design test cuts both ways: if a vertical ever needs to *fork* an engine, the engine
drew its line wrong; if a vertical hand-rolls tenancy, audit, or permissions, it's
reaching below its layer.

## A curated set, not a pile

These demos are chosen, not accumulated. Each one exists to prove a **different way of using
the platform** — a distinct point in the design space — so the set as a whole shows the
range, and no two demos teach the same lesson.

| Vertical | Package | The shape it uniquely shows | Engines composed |
|---|---|---|---|
| **[PeopleCo](/verticals/peopleco)** (HR) | `demos/hr` | The **shape-breaker** — a domain with *no ready-made engine*, so the kernel carries it alone; multi-country scopes diverging from one codebase; one **role-adaptive app** (employee + manager in the same surface) | `protocol` only |
| **ServiceCo** (field service) | `demos/fsm` | The **canonical composition** — two engines cooperating through events with zero imports between them (the star-topology showpiece), plus the *pricing moment* where vertical logic meets an engine transition | `workorder` · `invoicing` · `protocol` |
| **CykelService** (bike workshop) | `demos/bike-shop` | **Engine reuse** — the same engines under new vocabulary; the second shape that *forced the protocol engine to be extracted* from ServiceCo | `workorder` · `invoicing` · `protocol` |
| **Kallkälla** (coffee shop) | `demos/shop` | **Two audiences, one source of truth** — a customer storefront and a staff back-office as separate apps over one API; `invoicing` reused far outside field service | `invoicing` (+ its own commerce module) |

The through-line: **structurally repetitive, operationally rich** — the foundation is the
same, the vocabulary and shape are not. That is exactly the segment Substrat is for.
