---
'@substrat-run/kernel': patch
'@substrat-run/adapter-sqlite': patch
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/contract-tests': patch
---

`HostAdmin` is now asynchronous

Every `HostAdmin` method returns a `Promise` — writes (`createTenant`,
`setTenantStatus`, the scope-lifecycle transitions, `defineRole`/`assignRole`/
`grant`/`grantToOrg`/`addMember`, `grantEntitlement`/`revokeEntitlement`,
`linkIdentity`) and reads (`getTenant`, `listTenants`, `listEntitlements`,
`auditLog`, `resolveIdentity`) alike. `registerModule`/`defineOperation` stay
synchronous (code-time bookkeeping); `getScope`/`provisionScope` were already async.

Why: the pure adapter's synchronous admin worked only because it is in-process.
The Cloudflare adapter (D-14) proved a durable/remote control plane — a Durable
Object — cannot be synchronous, so the second adapter forced the interface to
evolve. This is the two-adapter discipline doing its job. Callers now `await`
admin calls; adapter-sqlite's methods present their synchronous SQLite work as
Promises. Behavior, error messages, and every contract assertion are unchanged.
