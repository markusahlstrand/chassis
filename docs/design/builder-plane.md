# RFC: the builder plane — tenant-owned verticals, self-serve

**Status:** proposed · **Depends on:** [self-serve-deploy.md](./self-serve-deploy.md) (the push
seam + §4 sandbox contract + models A/B/C), [scope-local-permissions.md](./scope-local-permissions.md)
(CP-less verticals, already shipped).

## 1. Problem

Everything about a *vertical's* lifecycle is staff-only today. `substrat push` is gated by
the staff roster, and admit/promote live in the staff **console** (`Verticals` view). So a
customer who builds a vertical cannot push it, see its versions, or manage its channels —
staff must stand in for them. Self-serve deploy (self-serve-deploy.md) is the whole point of
the push seam; the builder plane is the half that lets a *builder* drive it.

The scope side already went tenant-narrowed (dashboard.md §4: a customer provisions apps only
in their own tenant). This RFC does the same for the *vertical* side: a builder manages only
the verticals **they own**.

## 2. The model

**A vertical is owned by a tenant.** Not a bare user — an org. A **builder** is a user acting
*on behalf of* a tenant they are a member of (the same identity→tenant resolution the dashboard
already does via `listIdentityTenants`). When a user belongs to several tenants they select one
(a `--tenant` flag / a stored default), exactly the "pick your account" model.

**Vertical ids are prefixed: `<tenantSlug>/<name>`.** Slugs are customer-chosen, so they must
not collide across builders (self-serve-deploy.md §5.3). The tenant prefix makes the id globally
unique *by construction* — no claim race on the bare name. Crucially this prefixes only the
**registry id + `deploymentRef`**, never an app's hostname: a hostname is per *instance*
(`<appName>.<jurisdiction>.substrat.run`, chosen at create-instance), so prefixing the vertical
does not touch URLs.

**Staff keep the prod gate (model B).** A builder pushes, views, and manages **non-prod**
channels (`dev`/`staging`) themselves; **admission and promotion to `prod` remain a human staff
decision** — the trust boundary self-serve-deploy.md §3 is explicit about. Model A (an inspecting
build pipeline that makes admission mechanical) is the later evolution; only then does the staff
gate relax.

## 3. Ownership & the claim

The `verticals` registry row gains an **`owner_tenant`** (nullable → a reserved
platform-owned sentinel for first-party verticals; see §6).

- **First push of `<tenant>/<name>` claims it** for that tenant (the pushing builder's selected
  tenant). Recorded on `registerVertical`, alongside the existing `source`.
- **Subsequent pushes must be by the owner.** A push whose caller-tenant ≠ `owner_tenant` is
  refused — the same shape as `registerVertical`'s existing "already registered as X" conflict,
  now keyed on owner rather than source.
- Ownership is **not** transferable in v1 (a later admin action, if needed). Tombstone on
  offboarding, never silently reassign (K-21).

## 4. Builder authz

Today the control-plane API is one gate: `sessionPlatformAuth` (staff roster) / service token.
The builder plane adds a **second principal kind** — a *tenant user* — to the same surface:

- **Authenticate the human** as they already do for the CLI browser login (#171): the control
  plane mints/accepts its signed session; a new reader resolves it to `(userId, email)`.
- **Resolve to a tenant.** `userId → tenants` via the identity directory (the dashboard's
  `listIdentityTenants`), narrowed to the **selected** tenant. The result is a *builder
  principal*: `(userId, tenantId)`.
- **Authorize per endpoint** against `owner_tenant`:
  - `push` / `registerVertical` / `publishVersion` → caller-tenant claims-or-owns the slug.
  - `listVersions` / `listChannels` → filtered to the caller's owned verticals (staff see all).
  - `promoteVersion` → **only `dev`/`staging`** for a builder; `prod` (and `admit`) stay staff.

Staff auth is unchanged and remains a superset (staff act on any vertical). The builder path is
purely additive — a request that isn't staff and isn't an owning tenant is refused, fail-closed.

## 5. Where the prefix flows

- **Registry / channels / versions** — keyed on the full `<tenant>/<name>`.
- **`deploymentRefFor(slug, versionId)`** — must stay CF-script-name-safe (`[a-z0-9_-]`), so the
  `/` is flattened: `deploymentRef = <tenant>-<name>-<versionId>` (lowercased ULID keeps it
  unique + valid). The router/CP dispatch on this unchanged.
- **`resolveVertical` / the router** — look up by the full id → its `prod` version → `deploymentRef`.
  No behavioural change beyond the id shape.
- **Hostnames** — untouched (per-instance, §2).
- **`substrat push --slug <name>`** — the CLI sends `<name>`; the tenant comes from auth (or
  `--tenant`), and the control plane forms `<tenant>/<name>`. A builder never types their own
  prefix.

## 6. Migration — the existing platform verticals

`callout` (and any first-party vertical) is platform-owned. Reserve a platform tenant (e.g.
`platform/`), and migrate the existing bare `callout` → `platform/callout` — or grandfather bare
slugs as "owner_tenant = platform" and render them without a prefix. Either way the deployed
`callout` keeps working; the prefix is what *customer* verticals get. Decide the exact reserved
name + whether platform slugs render bare in the console.

## 7. Phased plan

1. **Registry ownership + prefixed ids.** `owner_tenant` column (append-only migration; both
   adapters), claim-on-first-push, prefixed `deploymentRef`, platform-vertical migration (§6).
   No authz change yet — staff still drive it, but the data model is right. *(Human checkpoints:
   migration diff.)*
2. **Builder authz.** The tenant-user reader + `(userId, tenantId)` builder principal, ownership
   checks on push/version/channel(non-prod). CLI `--tenant` + stored default; account selection
   when a user has several.
3. **Builder writes.** `substrat promote --channel dev|staging`, non-prod self-serve; `substrat
   push` end-to-end as a builder.
4. **Dashboard "Deployments" view.** The builder-facing mirror of the console's `Verticals` —
   their verticals, versions, admission state, non-prod channels; "request prod promotion" hands
   off to staff.

`substrat versions <slug>` (shipped) is phase-0 read-only visibility and slots in unchanged once
the endpoints are builder-scoped.

## 8. Open questions

- **Reserved platform prefix** — name, and whether platform verticals render bare (§6).
- **Tenant slug source** — the prefix is the tenant's slug; is it stable/unique enough, or do we
  mint a separate publisher handle?
- **Prod promotion request** — is staff admission a pure out-of-band action, or does a builder
  file a "promote to prod" request the console surfaces? (The latter is nicer UX; more surface.)
- **Vetting** — model B is "vetted builders." What gates a tenant becoming a *builder* at all
  (allowed to claim slugs)? An entitlement flag, presumably.
