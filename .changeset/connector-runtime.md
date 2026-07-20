---
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
---

**`registerConnector` — an executor that also gets a credential and sanctioned egress.**

The existing `ExecutorHandler` receives only `HostAdmin`, which is right for the one executor
that exists (a directory write) and insufficient for anything that talks to a provider: no
per-tenant credential, and no way to make an HTTP call that the platform can police.

```ts
registerConnector(id, eventType, handler, options?)

interface ConnectorContext {
  admin; tenantId; scopeId; vertical;
  connection(provider): Promise<ConnectorConnection>;   // opened credential + bound fetch
}
```

**Tenant and vertical are ambient**, taken from the event's scope rather than passed in, so a
connector cannot reach a credential another vertical connected even by accident.

**`fetch` is bound to the connection, not to the context.** Health has to land on the right
row by construction; an ambient `ctx.fetch` would make the runtime guess which connection a
call belonged to, and it would guess wrong the first time a connector talked to two. The
handler is *given* its fetch rather than importing one — the same move `ctx.sql` makes for
module code, and for the same reason: timeouts, egress policy and health become properties of
the seam instead of conventions an author has to remember.

Kept as a second registration rather than widening `ExecutorHandler`: a membership executor
should not be handed the machinery to call the internet. Both ride the same hardened dispatch,
journal and retry policy from #100.

Hosts take an optional `fetch`, so a provider can be stood up in memory. That is the only way
to exercise a connector end to end before vendor credentials exist, and it stays useful
afterwards because a real provider will not return 503 on demand.

Three new contract tests across both adapters: a connector receives its tenant's credential and
records health on success; a provider error is recorded on the connection; and a tenant with
the SKU but no connection fails the delivery visibly rather than silently doing nothing.
