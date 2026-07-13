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

No negation, no configurable rewrite rules. Tuples are scope-local and evaluated inside
the scope's serialization domain, so there is no distributed-consistency problem to
solve. Verticals never see or author tuples — roles and grants remain the only authored
surface. The checker interface is deliberately swappable (an OpenFGA-backed adapter is
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
import { assertAllowed } from '@substrat/kernel';

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
