---
"@substrat-run/control-plane-api": minor
"@substrat-run/dashboard": patch
"@substrat-run/dashboard-web": patch
"@substrat-run/demo-meridian": patch
"@substrat-run/demo-callout": patch
---

**A read-only "Data" tab: browse an app's own database from the dashboard.**

Cashes in the seam kernel-design §5.4 reserved as the *admin-query RPC* — a grant "is a
tuple in the scope's own database and needs an admin-query RPC" — as two narrow,
read-only `HostAdmin` primitives, `listScopeTables` and `readScopeTable`, and surfaces
them as a **Data** tab on the app detail view (list tables, page through rows).

Read-only and table-shaped **by construction**: the caller picks a table from the live
schema plus a bounded page — there is no user-supplied SQL, so there is no write path to
forge the spine and no injection surface. The `_substrat_*` spine reads back too, flagged
`system` so the UI groups it apart from the vertical's own tables. Every read is audited
(K-24) and fails closed on a mismatched `(tenantId, scopeId)` pair (K-3).

**Reaches the data where it actually lives.** One dashboard app = one scope = one
Durable Object = one database. In embedded mode the dashboard's own host owns that DO, so
it reads directly. In connected/prod the scope's data DO lives in the *vertical's own WfP
deployment* (K-31), not the control plane's own (empty-module) scope host — so the
control-plane `/tables` route **delegates to the vertical** through `VerticalClient`
(`GET /internal/tables`), the mirror of `provisionInstance`. `getScopeRecord` does the
K-3 check + audit and names the backing vertical; the same `verticals[slug] ??
resolveVertical` resolution provisioning uses reaches it; a co-located host falls back to
reading its own scope DB. The dashboard never emits an empty `200` — a null from the
platform surfaces as a clear `502` instead of an "Unexpected end of JSON input".

Additive throughout: new optional `HostAdmin` methods implemented by both adapters (with
a shared contract-tests suite), new `contracts` introspection schemas, and
`/internal/tables[/:table]` on the vertical workers (Meridian, Callout). Editing rows and
an arbitrary read-only SQL console are deliberately out of scope (fast-follows).
