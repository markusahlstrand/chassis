# Permissions

The permission **model** is kernel-owned — it is enforcement input, never delegated to
an auth provider. The **evaluation engine** is an adapter behind one interface, with a
built-in relationship-tuple engine as the default.

## The authored surface

Humans (and agents, under review) write three kinds of things:

### Permission keys

Module-namespaced strings declared in the [manifest](/concepts/modules) with
human-readable descriptions:

```
workorder:create   Create work orders
workorder:report   Start work, report time and material
invoicing:export   Export a fakturaunderlag (makes it immutable)
```

### Roles @ nodes

A role bundles permissions; an assignment binds a principal to a role **at a node of the
tenancy tree** — the tenant root or a specific scope — with inheritance down the tree:

```ts
host.admin.defineRole(tenantId, {
  key: 'technician',
  permissions: ['workorder:read', 'workorder:report'],
  source: 'vertical',
});

host.admin.assignRole({
  principalId: tech,
  roleKey: 'technician',
  node: { tenantId, scopeId: stockholmBranch }, // or scopeId: null = whole tenant
});
```

### Capability grants

Narrow, direct, time-boxable grants — one permission, one node, optionally **narrowed to
one entity** and its declared descendants:

```ts
host.admin.grant({
  principalId: portalCustomer,
  permission: 'workorder:read',
  node: { tenantId, scopeId: branch },
  entity: { entityType: 'facility', entityId: theirBuilding },
  expiresAt: nextMonth,      // optional
  grantedBy: adminPrincipal,
});
```

Entity-narrowed grants are how portal users (a customer, a board member, a
subcontractor) see only *their* facilities and orders inside a shared scope. Grants can
also target an **organization**; members reach them via membership.

Organizations are a real directory record, not a string you make up at the call site:

```ts
await host.admin.createOrg(actor, {
  id: orgId,          // branded ULID — slug and name are attributes, not identity
  tenantId,
  slug: 'acme',       // unique within the tenant
  name: 'Acme AB',
});
```

`addMember`, `removeMember`, `listMembers` and `grantToOrg` all **fail closed on an org
that does not exist in that tenant**. That refusal is the point of the record: a grant to
an org nobody registered would otherwise look applied, resolve for nobody, and still show
up in the permission diff as though access had been conferred. Because the id is a ULID
rather than a name, renaming an org cannot orphan the tuples that reference it.

## Evaluation: relationship tuples with a fixed algebra

Internally, the built-in checker compiles the authored surface into relationship tuples
(`subject → relation → object`) and evaluates checks with a **fixed, four-rule
derivation algebra**:

1. **Role expansion** — principal has role, role carries permission.
2. **Tenancy-tree inheritance** — permission at a node flows down to child scopes.
3. **Entity parent edges** — declared in module manifests (`workorder → facility`) and
   written at runtime via `ctx.link`; entity-narrowed grants flow along these edges,
   depth-capped.
4. **Org/group membership** — grants to an organization reach its members.

No negation, no configurable rewrite rules. Verticals never see or author tuples — roles
and grants remain the only authored surface.

**Where tuples live.** Scope and entity tuples (rules 2 and 3) live in the scope's own
database and are evaluated inside its serialization domain, so there is no
distributed-consistency problem for them. Tenant-level tuples — role assignments and org
membership (rules 1 and 4) — live in the **directory** instead, because they are
tenant-wide facts rather than scope-local ones. On the Cloudflare adapter that means a
separate Durable Object the checker reads over RPC. The distinction matters when you are
extending the kernel: a write path that is same-transaction for entity edges is not
same-transaction for membership.

## Revocation: tuples tombstone, they never disappear

Access is withdrawn by **tombstoning** a tuple — it keeps its row, gains a `revokedAt`,
and the checker's walk skips it. Nothing deletes a tuple.

That is deliberate. A tuple that once granted access is the evidence of *why* an access
was allowed, so deleting it destroys the audit trail exactly where it is most needed: a
deleted row can show neither that access was revoked nor that it was ever granted. Every
revocation path in the kernel works this way — `removeMember` is the first of them — and
`listMembers({ includeRevoked: true })` is the evidence view over the result.

Liveness is therefore one predicate, applied identically everywhere: a tuple grants only
while it is **unexpired and unrevoked**. Expiry (`expiresAt` above) and revocation are
siblings, not separate mechanisms. The checker interface is deliberately swappable (an OpenFGA-backed adapter is
the designated alternative), and any implementation must pass the same contract tests.

## Decisions carry proof

```ts
type Decision =
  | { allowed: true; proof: RelationTuple[] }   // the chain that granted access
  | { allowed: false; checked: PermissionKey; node: Node };
```

An allow **always** carries the tuple chain that produced it — an unexplained allow is
unrepresentable. This powers:

- **explain** — why does this user see this?
- **view-as-user** — render any screen as any principal, with real decisions;
- **the human-readable permission diff** — the review artifact for the permission
  checkpoint: who gains what, where in the tree.

## In operations

The standard first line of every operation:

```ts
import { assertAllowed } from '@substrat-run/kernel';

const handler: OperationHandler<Input, Output> = async (ctx, input) => {
  assertAllowed(await ctx.check('workorder:read', orderRef(input.orderId)));
  // ...
};
```

`ctx.check` evaluates the ambient principal at the ambient node. Pass an `EntityRef` for
per-entity checks: the checker tries node-level first (staff see everything in the
scope), then walks the declared parent edges against entity-narrowed grants (portal
users see their own things).

## Defaults

- `denyAllChecker` — the secure default. A host without an explicit checker allows
  nothing.
- `UNSAFE_allowAllChecker` — grants everything to everyone via a synthetic proof tuple.
  For tests and scratch scripts; the name is deliberately alarming. Never wire it into
  anything a tenant can reach.
