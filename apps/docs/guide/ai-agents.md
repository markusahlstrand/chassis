# Building for AI agents

Chassis treats coding agents as primary users of the platform, and that shapes the API
more than any other single requirement. If you're pointing Claude Code (or any agent) at
a Chassis vertical, this page explains what the platform does to keep generated code on
the rails — and what stays under human review no matter what.

## Small surface, strong types

A narrow, aggressively typed SDK means a small hallucination surface. The design goal is
that invalid states are unrepresentable in TypeScript:

- **Branded IDs** — a `ScopeId` will not typecheck where a `TenantId` is expected, so an
  agent cannot swap them silently. All IDs are ULIDs: opaque, sortable, meaning-free.
- **Discriminated unions** — a permission `Decision` is either
  `{ allowed: true, proof: [...] }` or `{ allowed: false, checked, node }`. An
  unexplained allow is unrepresentable.
- **Required classifications** — an event without a `piiClass` doesn't parse; a
  PII-classed event without a `subjectId` doesn't parse either.

## Mechanical pushback beats prompting

The platform is designed so that when generated code is wrong, something *fails* —
loudly, locally, and before production:

| Layer | What pushes back |
|---|---|
| Compile time | branded types, discriminated unions, `never`-typed foot-guns |
| Runtime boundary | Zod validation on every input, event, and manifest ("parse, don't trust") |
| Structure | no API exists for cross-tenant reads, unstamped events, or unchecked scope access |
| Tests | contract tests run on the pure-SQLite adapter — real kernel semantics in CI, no cloud account |
| Conventions | lint rules ban raw DB/fetch access in vertical code (the kernel SDK is the only data path) |

Prompting an agent to "be careful with tenancy" is a suggestion. A `getScope` call that
fails closed on a mismatched pair is a fact.

## Self-describing modules

The [module manifest](/concepts/modules) is what makes a Chassis system legible to an
agent without reading its implementation: every module declares its permissions (with
descriptions), the events it emits and consumes (with schema versions), its entity
relations, its migrations and compatibility window, and its UI contributions. An agent
scaffolding a new vertical can discover the whole surface of the installed engines from
their manifests.

## What agents must never self-approve

Two human checkpoints hold even in a fully agent-driven workflow:

1. **Schema migrations.** Migrations are plain, reviewable SQL, journaled per module.
   The agent writes them; a person approves them.
2. **Permission definitions.** Permissions are declared in manifests with human-readable
   descriptions, and every decision carries a tuple proof path — which makes "who gains
   what, where" reviewable as a diff rather than an archaeology project.

Everything else — screens, workflows, operations, reports — iterates at agent speed with
contained blast radius: the worst a bad operation can do is fail inside its own scope,
audited.

## Local loop

The pure-SQLite adapter is the agent's development loop: real serialization semantics,
real isolation, real stamped events, in-process, deterministic, fast. An agent can build
a module, run the contract tests, inspect the resulting `.sqlite` files, and iterate —
with no credentials and no shared environment to damage.
