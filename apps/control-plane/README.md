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

## Staff access

Who may act on the control plane lives in the `staff_actor` table in D1
(`migrations/0002_staff_roster.sql`), **not** in configuration. One
`PlatformActorId` per human, so the admin log can name who suspended a tenant;
before this every operator shared one hardcoded actor and the trail could not
tell them apart.

```sh
# grant access
wrangler d1 execute substrat-control-plane-auth --command \
  "INSERT INTO staff_actor (email, actor, name, added_at)
   VALUES ('someone@substrat.run', '<new ULID>', 'Someone', datetime('now'))"

# revoke it — a tombstone, never a DELETE (K-21): the row is the evidence that
# access was once granted, which is what an audit asks for
wrangler d1 execute substrat-control-plane-auth --command \
  "UPDATE staff_actor SET revoked_at = datetime('now') WHERE email = 'someone@substrat.run'"
```

Mint the actor with any ULID generator; it is that person's identity in the audit
log forever, so it must never be reused or changed.

An empty roster means nobody can act — fail-closed is the correct posture, and
recovery is the grant statement above. A managed surface for this belongs in the
console and is not built yet.
The dev-actor stub — which names a subject with cross-tenant reach — is mounted
only under `dev`/test, never in `wrangler.jsonc` (control-plane.md §6).
