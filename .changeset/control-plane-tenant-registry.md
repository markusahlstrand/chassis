---
'@substrat-run/contracts': patch
'@substrat-run/kernel': patch
'@substrat-run/adapter-sqlite': patch
'@substrat-run/contract-tests': patch
---

Control plane §4.1: tenant registry + lifecycle status

A real `tenants` table in the directory replaces "a tenant is a ULID nobody used
before". New `HostAdmin.createTenant` (idempotent, audited), `setTenantStatus`,
`listTenants`, and `getTenant`. A tenant whose status is not `active` fails
`getScope` closed for every scope under it — the K-3 fail-closed path, the
containment lever for non-payment or an incident, reversible without deletion.
Scopes provisioned without a tenant record (legacy path) are not gated, keeping
the change backward-compatible.
