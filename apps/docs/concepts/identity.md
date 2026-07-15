# Authentication &amp; identity

The kernel **authorizes**; it never **authenticates**. Every operation runs against an
ambient `PrincipalId` that is already established by the time the kernel sees it — the
kernel never learns *how* a caller proved who they are, only *who they are*. Authentication
is a swappable adapter at the edge (decision D-16).

## The line: authenticate vs authorize

- **Authorization is the kernel's** — roles, grants, tenancy, the tuple evaluator
  ([permissions](/concepts/permissions)). This is enforced on every operation and cannot be
  delegated to an outside system.
- **Authentication is an adapter's** — it takes a request (a session cookie, a bearer token,
  an OIDC `sub`) and resolves it to a `PrincipalId` + home node. Nothing more.
- An external IdP's **organizations/roles are a projection** of kernel tuples, never the
  source of truth. If you let an IdP's RBAC decide access, you have two permission systems
  fighting — exactly what the three-layer rule forbids.

## The neutral seam

The control-plane directory holds one provider-agnostic mapping:

```sql
_substrat_identities (
  provider     TEXT,   -- 'better-auth' | 'oidc:<issuer>' | …
  external_id  TEXT,   -- the provider's stable user id (e.g. the OIDC `sub`)
  principal_id TEXT,   -- the Substrat principal it resolves to
  tenant_id    TEXT,
  scope_id     TEXT,   -- NULL = tenant-level home
  PRIMARY KEY (provider, external_id)
)
```

exposed on the host admin as two methods:

```ts
linkIdentity(actor, { provider, externalId, principal, tenantId, scopeId? }): void // audited, idempotent
resolveIdentity(provider, externalId): { principal, tenantId, scopeId } | undefined
```

Because the mapping is **keyed by provider**, several auth adapters — and several OIDC
upstreams — coexist without collision. Adding one is additive: no schema change, no
permission, no kernel change.

## Auth adapters at the edge

An auth adapter is anything that turns a request into a principal:

```ts
interface AuthAdapter {
  resolve(headers: Headers): Promise<AuthResult | null>; // null = "not mine"
}
```

The server tries its mounted adapters in order; the first to recognise the request wins,
and the resolved principal is handed to `getScope`. Adapters are **chosen by config**, so a
deployment can run one, another, or several at once:

```
AUTH=better-auth,public    # a real session, else an anonymous browse-only fallback
AUTH=oidc                  # an OIDC / authhero adapter
AUTH=better-auth,oidc      # both doors — resolve to the same principal model underneath
```

**OIDC is not a separate burden.** Better Auth can federate upstream identity itself
(social, generic OIDC, enterprise SSO), so "log in with authhero/Google/SSO" becomes
config on the *same* adapter — or a second adapter against the *same* `resolveIdentity`.
Either way the kernel is untouched: doing the seam neutrally is what buys the choice.

## Identity sync on first login

The first time an adapter resolves an external user it hasn't seen, it provisions them —
the plan's §4.3 flow — then binds the identity:

1. mint a `PrincipalId`;
2. assign the role(s) that user should hold;
3. create the domain records they own (e.g. a customer);
4. issue any entity-narrowed grants (e.g. read-your-own-orders);
5. `linkIdentity(provider, externalId → principal)`.

From then on `resolveIdentity` short-circuits to the same principal — a stable identity with
real, enforced permissions.

## In the demo

The [Kallkälla Kaffe](https://github.com/substrat-run/substrat/tree/main/demos/shop) shop
uses **Better Auth** as its first adapter (email/password, its own store, entirely separate
from the scope-host DBs) plus a browse-only anonymous fallback. Pre-seeded logins let you
sign in as each persona and *feel* the permission model — the credentials are below.

| Log in as | Password | Role | Sees |
|---|---|---|---|
| `astrid@kallkalla.se` | `demo1234` | shop-admin | everything — catalogue, stock, orders, invoicing |
| `gustav@kallkalla.se` | `demo1234` | warehouse | orders + stock; **invoicing is denied** |
| `elin@cafepascal.se` | `demo1234` | customer | the shop + **only her own** orders |
| `otto@kontoret.se` | `demo1234` | customer | the shop + only his own orders |
| *sign up* | — | customer | a fresh principal, provisioned on first login |
| *(not logged in)* | — | public | browse the catalogue only |

Signing in as Gustav and watching *Fakturaunderlag* disappear from the nav — and 403 if you
ask for it directly — is the whole thesis in one click: **Better Auth authenticated you, the
kernel authorized you.**
