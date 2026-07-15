---
'@substrat-run/contracts': patch
'@substrat-run/kernel': patch
'@substrat-run/adapter-sqlite': patch
'@substrat-run/contract-tests': patch
---

Control plane §4.4: `PlatformActor` seam + append-only admin audit log (D-30, K-20)

Every `HostAdmin` mutation (defineRole / assignRole / grant / grantToOrg / addMember)
now takes a `PlatformActorId` — a staff subject branded distinctly from a tenant
`PrincipalId` — and writes an append-only row to a new `_substrat_admin_log` in the
directory, stamped host-side (actor, action, target, before/after, timestamp). A new
`HostAdmin.auditLog(filter?)` reads it back — the read path for the console history and
the permission-diff human checkpoint. `defineRole` captures the prior role in `before`.

Pre-release breaking surface change kept at patch: `HostAdmin` method signatures gained
a leading `actor` argument. Locally the actor is a dev stub; real staff auth gates
exposing the surface, not building it.
