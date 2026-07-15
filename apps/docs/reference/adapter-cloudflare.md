# @substrat-run/adapter-cloudflare

The **Durable-Object scope host** — the production backing for the same scope-host
contract the [pure-SQLite adapter](/reference/adapter-sqlite) implements. One
SQLite-backed Durable Object per scope, a durable control-plane DO for the directory, and
a stateless coordinator that mints capability stubs.

Both adapters pass the **same** [conformance suite](/reference/contract-tests) unchanged
(decision 14), so a vertical developed and CI-tested on pure SQLite runs on Cloudflare with
no code change. A demo vertical — [ServiceCo](https://github.com/substrat-run/substrat/tree/main/demos/fsm) —
runs deployed on it today, behind Better Auth.

```sh
pnpm add @substrat-run/adapter-cloudflare
```

## The pieces

- **`ScopeDO`** — one scope = one SQLite-backed Durable Object. `defineScopeDO([…modules])`
  bundles the kernel, engines, and the vertical's modules into the DO at build time (a DO
  can't receive handler closures over RPC). Each operation runs inside
  `ctx.storage.transaction(async …)` — the DO analogue of `BEGIN IMMEDIATE … COMMIT`, which
  rolls back on a throw *across `await`s* — with strict per-scope serialization, lazy
  migrations on wake, manifest guards, and the outbox→consumer dispatch loop.
- **`ControlPlaneDO`** — the durable directory: tenants, scope lifecycle, roles,
  entitlements, identities, tenant-level tuples, and the append-only admin audit log.
- **`CloudflareScopeHost`** — the coordinator. Stateless (rebuilt per request); it validates
  and gates against the control plane, then mints a `ScopeStub` that RPCs `invoke` into the
  scope's DO. Implements the same `ScopeHost` contract as the pure adapter.

## Usage (a Worker)

```ts
import { defineScopeDO, ControlPlaneDO, CloudflareScopeHost } from '@substrat-run/adapter-cloudflare';
import { workorderModule } from '@substrat-run/engine-workorder';

export const ScopeDO = defineScopeDO([workorderModule /*, …engines, vertical */]);
export { ControlPlaneDO };

export default {
  async fetch(req, env) {
    const host = new CloudflareScopeHost({ scope: env.SCOPE, controlPlane: env.CONTROL_PLANE });
    // authenticate → getScope → invoke (the ServiceCo demo wires a full Hono API + Better Auth)
    const stub = await host.getScope(principal, tenantId, scopeId);
    return Response.json(await stub.invoke('workorder/list', {}));
  },
};
```

`wrangler.jsonc` binds `SCOPE` + `CONTROL_PLANE` as SQLite-backed Durable Objects
(`new_sqlite_classes`). Run it on real `workerd` with `wrangler dev` (no account needed);
deploy with `wrangler deploy` (DO SQLite needs a Workers Paid plan).

## How the semantics map

| Contract guarantee | Implementation here |
|---|---|
| strict serialization per scope (K-6) | per-DO operation queue — the DO input gate over-delivers, so serialization is enforced explicitly |
| scope storage isolation | one SQLite-backed DO per scope |
| transactional operation + rollback (K-4) | `ctx.storage.transaction(async …)` — commits on success, rolls back on a throw across `await`s |
| structured-clone boundary | the coordinator→DO RPC boundary itself |
| fail-closed addressing + lifecycle gates | validated in the `ControlPlaneDO` before the stub is minted |
| permission checks | tuple checker — scope tuples local to the DO, tenant tuples + roles via the control plane |

## Status

Milestone 1: the shared contract suites run **green in workerd against real Durable
Objects** (one runtime-late-registration test is skipped — a deployed DO bundle is
code-time), the control plane is durable, and a vertical is deployed. Deferred, honestly:

- the directory is a single control-plane DO; the tenant-root-DO + global-D1 split
  (kernel-design §3.2) is a later scaling/blast-radius refinement;
- per-jurisdiction DO ids (K-7) and the `hostname → (tenant, scope, vertical)` router /
  Workers-for-Platforms multi-vertical dispatch are not built yet;
- Shape B (DO control plane fronting per-tenant D1) is not built.
