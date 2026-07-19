# @substrat-run/engine-booking

## 0.1.0

### Minor Changes

- d75814c: New engine: reservations as **allocation against capacity over an interval**.

  The platform's second invariant shape. Where `engine-workorder` is a state
  machine, a reservation is an allocation, and the thing that must never happen is
  two parties holding the same resource at the same time.

  **What it owns**

  - **No overallocation.** The sum of live allocations against a resource never
    exceeds its capacity over any instant. Exclusive booking is capacity `1`;
    above 1 is for fungible pools where nobody cares which unit.
  - **Half-open intervals** — a booking ending at 19:00 and one starting at 19:00
    do not collide.
  - **Holds with lazy expiry.** `held` requires an `expiresAt`; a lapsed hold stops
    counting without anyone sweeping it, so nothing breaks if a sweeper never runs.
  - **A state machine that cannot skip**, and append-only participants.

  **No locking code, and none needed.** The allocation check is a plain
  read-then-write, correct because a scope is a single Durable Object — one
  serialization domain, one writer. The consequence is a hard scoping rule: a
  resource's entire calendar must live in one scope. SQLite has no exclusion
  constraint, so the guarantee comes from the serialization domain rather than the
  database.

  **Deliberately absent:** timezones and calendar arithmetic (it takes absolute
  instants), pricing, and policy of any kind. It knows only _fill target_ and
  _deadline_.

  Notable surface decisions:

  - `move`, not a generic `update` — rescheduling keeps identity, roster and
    payments, and re-runs the allocation check excluding itself so nudging a
    booking that overlaps its own old slot is legal.
  - `open` sets a fill target on a reservation that already exists, so a private
    booking can be put on offer. `fillTarget` drives the auto-confirm, so it is
    engine state rather than something a vertical can keep beside it.
  - `availability()` returns free **intervals**, not slots: with mixed durations
    there is no canonical slot list.
  - Reservations carry `effectiveState` beside `state`, because lazy expiry is
    right for allocation and wrong for display.
  - Aggregate events carry `participantCount` and no identities; the roster travels
    on per-participant events keyed to their data subject, so a business record
    survives an erasure while the personal link is shreddable.

### Patch Changes

- @substrat-run/contracts@0.6.0
- @substrat-run/kernel@0.6.0
