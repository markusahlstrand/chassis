# Substrat

[![CI](https://github.com/substrat-run/substrat/actions/workflows/ci.yml/badge.svg)](https://github.com/substrat-run/substrat/actions/workflows/ci.yml)

**The hard parts, hosted.**

AI made building vertical B2B software fast — except for the parts that were never about
writing code: multi-tenancy, identity, permissions, integrations, data integrity, audit,
GDPR. Substrat is a hosted substrate that owns those parts and enforces them at runtime, so
small teams — including non-engineers wielding AI tools — can build production-grade
vertical SaaS on top.

We build the substrate. You build the verticals.

## The idea in three points

1. **Kernel** — everything true of every B2B SaaS, nothing true of any particular one.
   Identity, nested tenancy, permissions, documents, integrations, events/audit/reporting,
   modules. Owns no domain entities.
2. **Engines** — shared domain machinery (work orders, ticketing, protocols, scheduling)
   that owns invariants, while verticals own vocabulary, workflows, and UI.
3. **Verticals** — the businesses, built at AI speed on rails that make the speed
   survivable: generated code *cannot* cross a tenant boundary, skip the audit log, or
   touch raw credentials, because the guarantees live below the API surface.

## Status

Kernel scaffold under way: `@substrat-run/contracts` (Zod contracts — the source of truth),
`@substrat-run/kernel` (contract interfaces), `@substrat-run/adapter-sqlite` (pure-SQLite scope
host), and `@substrat-run/contract-tests` (the suite every adapter must pass). Run
`pnpm install && pnpm test`.

## Documentation

The canonical planning document is [docs/master-plan.md](docs/master-plan.md) —
thesis, architecture decisions, market landscape, concrete cases, commercial structure,
risks, open questions, and the decision log. Everything else derives from it.

The technical shape of those decisions — contracts, data models, lifecycles — lives in
[docs/design/kernel-design.md](docs/design/kernel-design.md).

Research feeding both:

- [docs/research/platform-landscape-drilldown.md](docs/research/platform-landscape-drilldown.md) —
  how the platform-with-modules incumbents (Odoo, SAP, Salesforce) and kernel-shaped
  foundations (Medusa, Supabase) handle extension, upgrades, and tenancy; why Substrat is
  a kernel, not an Odoo-class platform; and the lesson ledger mapping incumbent scar
  tissue to design decisions.
- [docs/research/fsm-vendor-feature-survey.md](docs/research/fsm-vendor-feature-survey.md) —
  feature survey of the Swedish/Nordic field-service-management market the first engines
  compete against.

Acceptance runs — the recurring "can an agent build a vertical unaided up to the human
checkpoints?" benchmark (master plan §5.6):

- [docs/acceptance/agent-loop-001.md](docs/acceptance/agent-loop-001.md) — run 001,
  CykelService (2026-07-14): PASS, with notes.