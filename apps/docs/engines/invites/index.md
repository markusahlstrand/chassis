# Invites engine

`@substrat-run/engine-invites` — how a person joins an organization they are not
already in.

The engine owns the state machine. It does **not** own the membership: membership is
tenant-wide directory state, so accepting an invitation asks the platform to add the
member and a privileged executor effects it. The engine's job ends at *"this person
said yes"*.

## Why it exists

Every multi-tenant product eventually needs to let a customer add their own colleagues,
and every one of them builds the same three mistakes:

- a lookup that confirms whether an address is already registered,
- an invitation that grants access before anyone accepts it,
- an unbounded, never-expiring standing offer.

Each is a small convenience and a permanent leak. This engine is the shape that avoids
them, once, for every vertical.

## The two properties that carry it

**Non-enumerable.** Identifiers are stored hashed and never returned — not in a list,
not in an event, not in an error message. A non-member, a decline, and an
already-invited person are indistinguishable to the sender. The invite surface can
never answer *"is this person on the platform?"*.

**Accept-required.** An invitation confers nothing until the recipient acts, and
accepting re-hashes the identifier they present. A leaked invitation id is therefore
not a bearer token for someone else's invitation.

## How these pages are organized

- [Domain model & invariants](/engines/invites/model) — the state machine, and what the
  hashing buys
- [Operations & permissions](/engines/invites/surface) — the four operations, and why
  one of them checks nothing
- [Events](/engines/invites/events) — what it emits, including the membership request
- [Composing & extending](/engines/invites/composing) — calling it from a vertical
