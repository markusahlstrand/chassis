# Dashboard

*"Vercel, but for Substrat."* The **tenant-facing self-service surface** — where a customer's
admin runs **their own** org. Sign up, get a tenant; provision apps (vertical instances) into it;
manage members, domains, connections, and the plan. Seeing only their own tenant, gated by
customer sign-up, not staff SSO.

It is the counterpart to the [Console](/platform/console): the Console is the operator's back
office (all tenants, run the platform); the Dashboard is the customer's home (one tenant, run my
org). Same platform, opposite audience and blast radius.

## The bet: the Dashboard is itself a Substrat vertical

The load-bearing decision is that the Dashboard is **built as a Substrat vertical** — the platform,
dogfooded on itself — which is what makes the hard part (authorization) fall out of the kernel
instead of being re-invented. The Vercel analogy maps almost one-to-one:

| Vercel | Substrat |
|---|---|
| Team / account | **Tenant** |
| Project | **Vertical instance** — "Acme HR" is a Meridian instance |
| Deployment / version | a registered **vertical version** bound to a scope |
| Environment | **Scope** — a tenant holds several |
| Team members | **principals + role assignments** |
| Domains | **hostname bindings** |
| Integrations | **connections** (Scrive, Fortnox) |
| "New Project from a template" | **create instance** (catalog → provision) |

Concretely: a customer *is* a tenant; sign-up bootstraps that tenant, one **dashboard scope** (the
customer's home), and the signer as its **owner**. A customer's apps are **scopes** in that same
tenant. The dashboard scope's own operations are the account actions — `dashboard/provision-app`,
`dashboard/list-apps`, `dashboard/mark-app-active`, `dashboard/delete-app` — each a real vertical
operation whose first line is a permission check. Provisioning an app is
`assertAllowed(ctx.check('dashboard:provision-app'))` then a **tenant-narrowed** `provisionScope`
into the caller's own tenant: the kernel refuses a caller without the key before anything is
created, and cannot provision into someone else's tenant by construction.

## Auth

Login is [AuthHero OIDC](/concepts/identity#two-real-choices-made-differently) through the shared
[`@substrat-run/oidc-rp`](/reference/oidc-rp) relying party. Unlike the Console's staff-roster
gate, the Dashboard does a **JIT tenant bootstrap**: a new user's first sign-in provisions their
own tenant and dashboard scope, and makes them its owner.

## Status

Built and connected — self-service sign-up bootstraps a tenant, the catalog offers a real
[Callout](/verticals/callout) entry, and provisioning runs through the tenant-narrowed control-plane
seam (an app becomes a live scope; deleting one deprovisions it for real). It is served as a React
SPA bundled into its worker. The full designed surface (members, domains, connections, billing) is
the roadmap the [design note](https://github.com/substrat-run/substrat/blob/main/docs/design/dashboard.md)
lays out; provisioning and the app lifecycle are the parts that exist today.
