---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
---

**The inbound authority seam (#97): a connection is a subject.**

A provider's callback has to write back into a scope, and it is not a person. `getScope`
demands a `PrincipalId`, so a connector could dispatch a document and then be unable to record
that it had — which under at-least-once delivery means a retry sends a **second** one.

```ts
getConnectorScope(connectionId, scopeId): Promise<ScopeStub>;
grantToConnection(actor, grant): Promise<void>;
```

**The door inherits its narrowing.** A connection is keyed (tenant, vertical, provider), so
`getConnectorScope` refuses another tenant's scope, another vertical's scope, and a revoked
connection — none of it re-declared, just the key enforced where it could have been widened.

**Authority is an ordinary permission grant**, not a second mechanism. Tuples already expire,
tombstone on revoke (K-21), carry a proof, and appear in the permission diff. A parallel
"allowed operations" list — the first design — would have been a second gate that only one of
the two would show up in a review.

**A connection is not a person, and the model now says so.** `PermissionChecker.check` takes a
`CheckSubject` (`{ kind: 'principal' } | { kind: 'connection' }`) instead of a `PrincipalId`.
Minting a principal per connection would have been cheaper and wrong: every audit view would
show a `principal:` subject for something that is not one — the confusion `PlatformActorId`'s
separate brand exists to prevent. So the tuple proof reads `connection:01J…`, the event actor
is `{ connection }` beside the existing `{ system }`, and membership expansion is skipped for a
connection rather than queried — it belongs to no org and holds no role, so a role carrying a
permission cannot leak into it.

**Breaking for custom checkers.** Any `PermissionChecker` implementation must take a
`CheckSubject`; `asPrincipal(id)` is exported for the common case. Both built-in adapters and
the contract suite are updated.

Five new tests in the permission contract suite, against the real tuple checker on both
adapters: opening the door confers nothing · a grant allows exactly what it names and proves it
with a `connection:` tuple · no roles or memberships leak in · another tenant's or vertical's
scope is unreachable · revoking the connection closes the door in the same act that destroys
the credential.
