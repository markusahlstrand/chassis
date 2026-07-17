# @substrat-run/control-plane

The **shared control-plane deployment** — the directory-side control plane
(control-plane.md §4) as one deployable Cloudflare Worker. Slice 1 of
[the first end-to-end flow](../../docs/design/first-flow.md).

A singleton `ControlPlaneDO` (tenant registry, scope lifecycle, entitlements,
roles, admin audit log) fronted by the audited `createControlPlaneApi` router.
This is the one deployment the whole platform shares: verticals register their
tenant/scope here, and the console reads and acts through it. Nothing
domain-shaped runs here — the module-less `ScopeDO` binding exists only because
the coordinator's `provisionScope` still instantiates one (see `src/worker.ts`;
decoupling that is slice 4).

Private, never published — it is a deployment, not a package.

## Run it

```
pnpm --filter @substrat-run/control-plane dev       # wrangler dev, no account; ALLOW_DEV_ACTOR on
pnpm --filter @substrat-run/control-plane test      # workerd test (the slice-1 DoD)
pnpm --filter @substrat-run/control-plane deploy     # needs a Workers Paid plan (DO SQLite)
```

Against `dev`, the UNSAFE `x-platform-actor` header is trusted:

```
curl -s -H 'x-platform-actor: 01JZ0000000000000000000001' http://127.0.0.1:8787/tenants
```

## Auth posture

Secure by default: a real `wrangler deploy` sets no `ALLOW_DEV_ACTOR`, so every
request **fails closed (401)** until real platform-staff auth lands (slice 3).
The dev-actor stub — which names a subject with cross-tenant reach — is mounted
only under `dev`/test, never in `wrangler.jsonc` (control-plane.md §6).
