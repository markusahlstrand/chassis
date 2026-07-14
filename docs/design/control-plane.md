# Control plane design

**Status:** proposed. Implements plan decision 30; kernel design log K-20.
**What this is:** the **shared platform layer that N per-vertical deployments sit on** —
the tenant registry, scope lifecycle, entitlements, custom hostnames, the audited admin
surface, and the console over them. Plus what is deliberately *not* built: billing.

Read alongside [kernel-design](kernel-design.md) §3.2 (directory), §3.3 (provisioning
lifecycle), §5.4 (operating the scope fleet), §5.5 (deployment topology), and
[master-plan](../master-plan.md) §9 (the four meters).

---

## 1. The frame: one platform, N deployments

§5.5 pins **one kernel-runtime deployment per vertical** — separate DO namespaces,
separate code, per-vertical blast radius and versioning. It is tempting to read that as
"every vertical replicates the platform." It does not, and the distinction is the whole
design:

| Layer | Shared (kernel-owned) | Per-vertical |
|---|---|---|
| Routing | Router worker resolves `hostname → (tenant, scope, vertical)` (§5.5) | — |
| Custom domains | Cloudflare for SaaS: custom-hostnames API, DNS validation, cert lifecycle — part of **scope provisioning** | — |
| Tenancy | Tenant registry, scope directory, provisioning lifecycle | — |
| Identity | Auth callbacks, principal derivation, capability minting (D-16) | — |
| Entitlements | The store; the module-load gate (D-20) | The `entitlementKey` each manifest declares |
| Analytics / history | Outbox → Pipelines → Iceberg; Tier 2 (§5.3) | — |
| Admin | This document: console, audit log, admin-query RPC | — |
| **Execution** | — | **The scope-DO class**: kernel + engines + that vertical's modules, and their migrations |

Everything a vertical would hate to rebuild is already shared. The *only* per-vertical
thing is the code that executes inside a scope. **The DO class is the app binary; the
platform beneath it is one platform.** The router already returns a `vertical` — multi-
vertical is designed in, not bolted on.

**The control plane is that shared layer.** Not an admin screen with a database behind it —
the layer that makes N independently-versioned, independently-owned vertical deployments
behave like one product. Orchestrating those N deployments (open question 9) is therefore
not a footnote to this design; it is the thing the design is *for*.

### 1.1 Why the deployments do not merge

Collapsing the N scope-DO classes into one shared deployment buys a single deploy to
operate. Rejected, on the layer it would damage:

- **Migrations become globally ordered across unrelated verticals.** Every scope would
  carry every vertical's modules, and module registration order is already a migration-
  ordering contract. A change to vertical B's migration list would touch vertical A's
  scopes.
- **Blast radius merges.** A bad deploy of B's module code takes down A's scopes — the
  exact property §5.5 splits deployments to keep.
- **Versioning goes lockstep**, and this is the disqualifying one. A shared binary means
  every vertical upgrades together — but per §9's ownership map, verticals are owned by
  *different companies*. Forcing one company's vertical to upgrade because another shipped
  is push-upgrade-across-a-fleet-you-don't-control: §7.8 and open question 12 name it as
  *the most documented failure mode across every platform ecosystem studied*. Adopting the
  Odoo/SAP treadmill to save operating a deployment is a bad trade.

The coherent counter-design is a shared bundle where the entitlement store registers only
the relevant vertical's modules per scope. It is not stupid — it is how ordinary
multi-tenant SaaS works — but it converts a **structural** guarantee into a **config**
guarantee, the move this codebase refuses everywhere else (K-8 bans the raw DO namespace
binding rather than trusting vertical code not to use it; K-3 fails closed rather than
trusting the caller). It also puts every vertical's code in every isolate, against a real
Workers bundle ceiling as engines accumulate.

## 2. The finding this starts from

**The tenant does not exist.** §3.2 specifies the directory as "the **only** complete
inventory of tenants and scopes, and the input to reconciliation, migration sweeps,
billing, and ops." What is implemented is the *scope* half of that sentence. There is no
`tenants` table in any adapter: a tenant is a foreign-key string on scope rows and a
subject in tuples. The `tenant` schema in `packages/contracts/src/tenancy.ts` — slug, name,
status, createdAt — is parsed by nothing and persisted nowhere. You create a tenant by
provisioning a scope with a ULID nobody has used before.

The hole runs through the whole shared layer:

| Designed | Implemented |
|---|---|
| Tenant registry (§3.2) | — nothing; tenant is an FK string |
| Lifecycle `provisioning → active → suspended ⇄ active → archiving → archived` (§3.3) | `provisionScope` only; `status` exists, nothing transitions it |
| Entitlements gate module loading (D-20); `manifest.entitlementKey` on every module | The field is declared and **read by nothing** |
| Audited admin-query RPC in an ops console (§5.4, plan §6) | `HostAdmin` — five methods, no caller identity, no record |
| Active-scope billing meter (§9; §3.3 "keeps the meter honest") | No meter, and nothing ever leaves `active` |
| Hostname → (tenant, scope, vertical) map as directory data (§5.5) | — |

The console is not a feature on a finished kernel. It is what forces the shared layer that
a year of decisions already specified to actually get built. The UI is the cheap half.

## 3. What can be a vertical, and what cannot

The admin's two halves have different answers, and conflating them was an error worth
naming.

**The effecting half cannot be module code.** Provisioning, suspend, archive, entitlement
flips, hostname issuance, the admin-query RPC — these mutate the directory and reach into
*other deployments'* DO namespaces. Module code cannot do this and should never be able
to: a vertical's app worker holds exactly one privileged binding, a service binding to its
own kernel entrypoint, and **never a raw DO namespace binding** (K-8). An admin vertical
would run in its own deployment, in its own DO namespace, and would have no addressable
path to another vertical's scopes. It is not *dangerous* — it is **impotent**. Granting it
the path means building the out-of-band control plane anyway, with extra steps.

**The record-keeping half can be a vertical**, and probably should be, eventually. The
tenant registry, plan and contacts, staff roles, and the admin action trail are ordinary
scope-shaped data. A "platform tenant" scope would get the outbox (audit for free),
the tuple engine (staff permissions, and the permission-diff checkpoint on real
machinery), and migrations — from the kernel, rather than reimplemented beside it. The
tell that this is right: §4.4 below proposes an append-only admin log, stamped
platform-side with actor/action/target, which the caller cannot forge. *That is
`_substrat_outbox`.* Rebuilding the kernel's audit mechanism next to the kernel is a smell.

The bridge between the halves is a pattern the plan already owns — **D-18's triage rule:
effects on the outside world are connectors.** The control-plane vertical emits
`tenant.provision_requested`; a privileged executor outside module code consumes it, acts
through the host admin surface, and emits the result back. Module code still never obtains
a cross-tenant stub, so K-3 and K-8 are untouched.

**Sequencing, honestly.** The split is more elegant, it dogfoods, and the dogfooding is a
sales asset. It is also more moving parts: provisioning becomes async (compatible — §3.3
already requires idempotent and journaled — but *suspend-for-incident* being async is worse
than a synchronous call); the audit trail splits across the vertical's outbox and the
executor's log and needs correlation; and there is a bootstrap chicken-and-egg (who
provisions the platform tenant's scope? an out-of-band seed — trivial, but real). Against
that, the hand-rolled audit log the split would save is perhaps fifty lines.

So: **build the effecting half out-of-band now** — there is no alternative — and treat
record-keeping-as-a-vertical as a sequenced option, taken when the platform tenant holds
enough data to earn a deployment. Decide it at the second vertical, which is also when
open question 9 stops being theoretical. What must *not* happen is writing "the admin is
never a vertical" into the log: it is false, and it forecloses the dogfooding.

## 4. What gets built

### 4.1 The tenant record

A `tenants` table in the directory, persisting the `tenant` contract that already exists.
`createTenant` becomes a real idempotent control-plane operation instead of a side effect
of minting a ULID.

`status: active | suspended | deleting` acquires meaning: `suspended` fails `getScope` for
every scope under the tenant — fails closed, the same path as K-3 — which is what makes
non-payment or an incident containable without deleting anything.

### 4.2 Scope lifecycle

Implement the §3.3 transitions that exist only on paper: `suspend`, `unsuspend`, `archive`,
`unarchive`. Two properties carry over from the design doc and must not be quietly softened:

- **Un-archive is a restore, not a flag flip.** §3.3 says so, and §9's meter depends on it:
  if archiving is free to reverse, "active scope" is not a number anyone can charge on.
- **Jurisdiction is immutable** — fixed at provisioning (K-7). The console displays it and
  offers no edit affordance.

Hostname provisioning (custom-hostnames API, DNS validation, cert lifecycle) is part of
this lifecycle, per §5.5 — it is control-plane work, and the `hostname → (tenant, scope,
vertical)` map is directory data the router reads.

### 4.3 The entitlement store

D-20 says entitlements gate module loading, and every manifest declares an
`entitlementKey`. Nothing reads it, so the SKU model is a promise with no mechanism.

Build the smallest thing that makes the declaration true: an entitlement set per tenant in
the directory, checked at module load. A module whose key is not held does not register —
its operations do not resolve, exactly as if it had never been registered (the same shape
as manifest `withdraws`). Granting an entitlement is a control-plane action; it is the
point of the console.

Open: whether the check sits on the hot path of every module load or is cached in scope DOs
with event invalidation — kernel-design open question 5. Building the store is what forces
it. Start simple (check at load, no cache); let a benchmark decide.

### 4.4 The platform actor and the admin audit log

The one thing that must not be retrofitted. Every control-plane mutation:

- takes a **`PlatformActor`** — an opaque authenticated subject, **typed distinctly from a
  tenant `PrincipalId`** so the compiler refuses to confuse them (a platform actor is not a
  principal in any tenant);
- writes an **append-only audit row**, stamped platform-side with actor, action, target
  `(tenantId, scopeId?, vertical?)`, before/after, timestamp — never supplied by the caller.

Same argument as K-4, and the reason the kernel is trusted at all: a surface that can act
without a durable record of who acted is worse than no surface. (If §3's record-keeping
vertical lands, this log *becomes* that scope's outbox rather than a second mechanism.)

`HostAdmin`'s five existing methods (defineRole / assignRole / grant / grantToOrg /
addMember) move behind this actor-taking, audited surface. Their current signature — no
caller, no record — is a v0 stopgap the code comment already admits.

### 4.5 The console

Thin, over the above. In build order:

1. Tenant list; tenant detail (scopes, entitlements, status, **which vertical** each scope runs).
2. Create tenant; provision scope; suspend / archive.
3. Entitlement grants.
4. **Roles and grants — the permission diff.**
5. Read-only history: the admin audit log; per-scope events via §5.4's admin-query RPC.
6. Fleet view: per-vertical deployment versions, migration status, scopes-behind counts —
   the §5.4 "fleet questions never fan out" surface, answered from the directory index.

**The permission diff is the sleeper feature.** CLAUDE.md names two human checkpoints agents
may never self-approve — the migration diff and the permission diff — and *neither has a
home*. Rendering "key → description → which roles hold it" is exactly what D-23's proof
paths were built to power ("explain / view-as / the reviewable permission diff"). The
console is where that checkpoint stops being a convention in a markdown file and becomes a
screen someone has to click. That is a stronger argument for building it than tenant CRUD is.

Plan §6 already lists the ops console as **build, internal first** — registry/tenant health,
migration and reconciliation status, billing state, and consented, audited support
impersonation. This is that line item.

## 5. Billing: meter, do not bill

**No billing system, no payment rail, no invoicing in v1.** Instead: make the meters that
are honestly computable *honest*, and display them.

- **Meter 1 (base fee: per tenant + per active scope)** is a `COUNT` over the directory once
  `status` actually transitions — which §4.2 delivers. Free. Ship it as a number.
- **Meter 2 (per-engine licensing)** becomes computable the moment §4.3's entitlement store
  exists: entitlement flags *are* the SKUs (§9). Also free.
- **Meter 3 (usage: Tier-2 events retained, storage GB, API calls)** is **not** computable.
  `_substrat_outbox` is per-scope-database, so any cross-tenant aggregate needs the Tier-2
  fan-in sink that does not exist yet; reads emit nothing, so API-call volume is unmeterable
  from the spine *by construction*; and `drained_at` is declared but written nowhere in the
  repo, so a metering consumer has no cursor to resume from.
- **Meter 4 (network transactions)** needs the cross-tenant order flow (§5.4, plan §8.4),
  which does not exist.

The rule: **a meter you cannot compute is not a pricing decision, it is a data-pipeline
project.** §9's four meters are a commercial design, correctly made in advance; three of
them sit downstream of infrastructure still on the roadmap. Build the two that fall out of
work you are doing anyway, show the numbers, and let the first invoice wait until someone is
actually paying — at which point the pricing conversation will have facts in it.

## 6. Auth: the sequencing

**Identity does not gate building this.** The data model — tenant record, lifecycle,
entitlement store, audit log — needs to know *that* there is an actor, not *how* it
authenticated. §4.4's `PlatformActor` is that seam: implement it now, run a dev stub behind
it locally, and the whole control plane is buildable and testable without touching identity.
D-16 already commits to identity being a swappable adapter; this is that being cashed in.

Two consequences:

1. **Real auth gates *exposing* the console, not *building* it.** Nothing with cross-tenant
   reach goes anywhere non-local on a stub. The demo's `x-principal` header
   (`demos/fsm/src/server.ts`) is a dev affordance; a super-admin on top of it is a
   liability, not a milestone.
2. **Platform-staff auth is a different regime from tenant-user auth.** Staff: SSO, MFA, no
   self-service signup, short sessions, a small closed population, plausibly its own IdP
   tenant. Tenant users: the authhero path, self-service, org membership. Two jobs; only one
   is on this critical path.

Inverting the order means designing the admin's auth before knowing what the admin *does* —
and the actions decide the auth. Whether destructive actions (suspend, archive, entitlement
revocation) need four-eyes approval is a real question that changes the session and approval
design, and it is unanswerable until the action list is real. Build the actions; let them
specify the gate. (Kernel-design open question 14.)

## 7. Consequences and risks

- **Open question 9 is now the center, not a footnote.** The control plane orchestrates N
  per-vertical deployments: engine-version upgrades across verticals owned by different
  companies (§7.8, open question 12), migration sweeps, reconciliation, and the fleet view.
  This document builds the *directory-side* control plane. The *deployment-side* one — who
  runs an engine upgrade across verticals, and what revalidates vertical-declared substates
  and custom fields against a new engine version — is the next hard problem and is **not**
  answered here.
- **The directory becomes a real database**, with its own migrations and backup story. Today
  it is an incidental index; after this it holds the tenant registry, the entitlement store,
  the hostname map, and the admin audit log. Losing it is losing the platform, not losing a
  cache. §3.2's reconciliation (tenant-root authoritative, global index a projection) stops
  being a paragraph.
- **`boundary-lint` is unchanged.** The control plane is not module code — it never receives
  a `ctx`, never runs in a scope's serialization domain. It must not acquire a back door into
  scope DBs: the only sanctioned path is §5.4's audited admin-query RPC, and that should be
  lint-visible.
- **Suspension is a live weapon.** Tenant `status: suspended` failing `getScope` closed is
  correct, and is also a one-click outage for a paying customer. It needs the audit log and,
  plausibly, the four-eyes question above.
