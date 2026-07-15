---
'@substrat-run/contracts': patch
'@substrat-run/kernel': patch
'@substrat-run/adapter-sqlite': patch
'@substrat-run/contract-tests': patch
---

Control plane §4.2: scope lifecycle + structural audit + mandatory tenant

`provisionScope` becomes the first audited scope-lifecycle transition — it now
takes a `PlatformActor`, requires an existing active tenant (a scope with no
tenant record fails closed), and audits. New `HostAdmin.suspendScope`,
`unsuspendScope`, `archiveScope`, and `unarchiveScope` implement the §3.3
transitions, validate the legal transition graph (fail closed on an illegal
one), and audit before/after; un-archive is an explicit restore, never a silent
flag flip. `getScope` now gates on both tenant-active AND scope-active, so
suspend/archive actually contain.

Audit is now a single `recordAdmin` choke point every mutation routes through —
"no mutation without a durable record" holds by construction, not per-method
discipline. The step-2 "legacy scopes without a tenant" passthrough is removed:
every scope has a tenant with a status.
