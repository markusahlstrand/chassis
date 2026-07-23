# Router

**One worker in front of every vertical.** It resolves an inbound
`hostname → (tenant, scope, vertical, surface)` against the [control plane](/platform/control-plane)'s
directory and forwards the request to the right vertical over a service binding, asserting the
resolved node in `x-substrat-*` headers. Before it existed, a provisioned scope had no URL — the
console faked one with an env var.

It is built on [`createRouteResolver`](/reference/adapter-cloudflare) (the adapter's `routing`
subpath). K-26/K-27.

## Why one router

- **Not one per vertical.** Cert and DNS lifecycle in one place means a new vertical gets custom
  domains for free instead of repeating the Cloudflare-for-SaaS dance each time.
- **Not one per jurisdiction.** The router is stateless and holds nothing regional, so a per-region
  router would duplicate the cert/DNS lifecycle and buy nothing. *Verticals*, by contrast, **do**
  deploy per jurisdiction (K-30): `substrat-fsm-eu` binds EU storage and cannot reach US data — a
  worker that *cannot* beats one that merely chooses not to. So `verticalFor` keys on
  `(slug, region)`, and the router refuses a request whose edge region contradicts the directory.

This does not erode the decision against bundling verticals into one DO class (D-30): a router
*forwards*; deployments stay separate, and upgrade on their own schedules.

## The trust boundary

A vertical trusts the `x-substrat-*` headers **absolutely** — they name the tenant whose data it
will serve. Two things keep that safe, and both are required:

1. **Vertical workers have no public route** (`workers_dev: false`, no route) — reachable only by
   service binding from the router.
2. **`ROUTER_SECRET`**, the same value on the router and every vertical, presented as
   `x-substrat-router` and verified in the kernel (`readRoutedNode`).

(2) exists because (1) is a deployment fact and `workers.dev` is on by default — one forgotten
toggle makes (1) false with nothing in the code noticing, and the consequence is a cross-tenant
read. The router also **strips every inbound `x-substrat-*` header** (by prefix) before setting its
own, so a client cannot forge a node.

## Status

The hostname → node resolution, the trust boundary, and dispatch are built. Hostname
*provisioning* — the custom-hostnames API, DNS validation, cert issuance — is not, so a binding is
made `active` by hand and a wildcard under a domain we control carries it until then. The static
`VERTICAL_<SLUG>` service-binding map is the milestone-one shape; customer-pushed verticals move
the lookup to a Workers-for-Platforms dispatch namespace, which changes `verticalFor` and nothing
else.
