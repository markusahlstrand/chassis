# Invites: events

| Type | When |
|---|---|
| `invites.sent` | a new invitation is recorded |
| `invites.accepted` | the recipient accepts |
| `invites.revoked` | an unaccepted invitation is withdrawn |
| `member.add-requested` | on acceptance — the membership request |

All payloads are `piiClass: 'none'` and **contain no identifier**. The event spine
outlives the row it describes, so an address leaked here is leaked for as long as
history is kept.

## `member.add-requested` is the interesting one

The engine cannot write a membership tuple. Membership is tenant-wide directory state,
outside this scope's transaction — so the engine *asks*, and a privileged
[executor](/concepts/events#the-connector-seam) effects it.

```ts
{
  principal,      // who accepted
  orgId,          // which organization
  tenantId,
  roleKey,        // what the invitation offered
  invitationId,   // provenance
}
```

The payload is deliberately **fat**: the executor must never need a cross-module read
to act on it.

This is also why acceptance is atomic in the way that matters. `ctx.emit` commits with
the engine's own write, so an accept that fails leaves no event and therefore no
membership. An in-scope cross-database write could not offer that — it could land in
the directory and then be orphaned by the scope's rollback.
