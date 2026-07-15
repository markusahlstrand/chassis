---
'@substrat-run/contracts': patch
'@substrat-run/kernel': patch
'@substrat-run/adapter-sqlite': patch
'@substrat-run/contract-tests': patch
---

Control plane §4.3: entitlement store — `manifest.entitlementKey` finally gates loading

`manifest.entitlementKey` was declared on every module and read by nothing (D-20
was a promise with no mechanism). Now a per-tenant `_substrat_entitlements` set
gates module loading, default-deny: an operation whose owning module's SKU flag
the tenant does not hold does not resolve — the same fail-closed shape as manifest
`withdraws`. New `HostAdmin.grantEntitlement`/`revokeEntitlement` (idempotent,
audited) and `listEntitlements`. The check runs per invoke (the simple, uncached
path — a DO-cached variant is kernel-design open question 5). Entitlement flags
are the SKUs meter 2 (§5) counts. Demo seeds grant the flags for the modules each
vertical runs — the SKU model in use.
