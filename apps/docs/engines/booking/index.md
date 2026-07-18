# Booking engine

`@substrat-run/engine-booking` — reservations as **allocation against capacity over an
interval**. A resource is held for a span of time, and concurrent allocations may never
exceed that resource's capacity. It deliberately knows nothing about timezones, pricing,
opening hours, or who is allowed to book — all of which are the vertical's.

## At a glance

| | |
|---|---|
| **Package** | `@substrat-run/engine-booking` |
| **Entitlement key** | `booking` |
| **Owns** | the allocation invariant, the reservation state machine, holds and their expiry, append-only participants |
| **Emits** | 11 events, `booking.held` → `booking.completed` ([events](./events)) |
| **Consumes** | nothing — it is a source, not a sink |
| **Permissions** | 8 (`booking:create` · `read` · `hold` · `confirm` · `cancel` · `move` · `complete` · `manage-resources`) |
| **Status** | product seed (0.x) — surfaces change until the first vertical ships |

## What it owns

- **No overallocation, ever.** For any resource, the sum of live allocations over any
  instant never exceeds its capacity. Exclusive booking is capacity `1`; capacity above 1 is
  for genuinely fungible pools (rental equipment, general-admission slots) where nobody
  cares *which* unit.
- **Intervals are half-open** — `[startsAt, endsAt)`. A booking ending at 19:00 and one
  starting at 19:00 do not collide. Stated once, relied on everywhere.
- **A hold is never permanent.** `held` requires an `expiresAt`, and expiry is *lazy*: a
  lapsed hold simply stops counting, with no sweeper to run and nothing to go wrong if one
  never runs.
- **The state machine cannot skip.** `held → confirmed → in_service → completed`, plus
  `held → expired` and `confirmed → cancelled | no_show`. Invalid transitions throw.
- **Participants are append-only.** Leaving sets `left_at`; the row survives, so the record
  of who was on a booking stays intact.

### The property worth understanding

**There is no locking code in this engine, and none is needed.** The allocation check is a
plain read-then-write. It is correct because a scope is a single Durable Object — one
serialization domain, one writer — so the read and the write that follows it never
interleave with another transaction.

That has a hard consequence for how you scope: **a resource's entire calendar must live in
one scope.** Split one court's bookings across two scopes and you have silently
reintroduced distributed locking, with nothing to tell you. SQLite has no exclusion
constraint, so the guarantee comes from the serialization domain rather than from the
database.

## What it will not do

- **Timezones and calendar arithmetic.** The engine takes and compares absolute instants.
  "Every Tuesday at 19:00", opening hours, DST — all vertical. See
  [composing](./composing).
- **Pricing.** It never learns what a slot costs. Duration is an input, not a multiplier.
- **Policy of any kind** — cancellation windows, who may book, skill bands, membership. It
  knows only *fill target* and *deadline*.
- **Field patches.** Mutations are named transitions. There is no `updateReservation`;
  rescheduling is [`move`](./surface), and participants change through join/leave.

## Is this a good match?

Reach for it when something scarce is held for a span of time and double-booking is
unacceptable: courts and pitches, salon chairs, workshop benches, meeting rooms, clinic
slots, equipment rental, classes with a seat count.

Reach for something else when the thing you are modelling has no interval (a queue, a
ticket) or when "capacity" is really inventory that depletes rather than a slot that frees
up again afterwards.
