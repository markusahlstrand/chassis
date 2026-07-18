# Demo Vertical — "RallyPoint" (racket-club booking)

Status: draft v0.1 · Last updated: 2026-07-18

> Companion to [booking-social.md](../../../docs/design/booking-social.md) (the tier split,
> locking model, and outbox seam) and [concept.md](../../fsm/spec/concept.md) (the reference
> demo). Anonymization per the master plan: the feature set is derived from **the racket-club
> vendor's** public product surface (Playtomic Manager) — deliberately, so demo work seeds a
> real `engine-booking` rather than a throwaway.

## 1. What the demo must prove

`fsm` already proved the three-layer split, the star topology, and structural enforcement.
This demo must prove **new** things or it is not worth building:

1. **A second invariant shape.** `workorder` is a *state machine*; `booking` is
   **allocation against capacity over an interval**. Different primitive, same kernel.
2. **Locking is structural, not code.** Two players race for the last slot; one is rejected
   — with no lock, no `SELECT … FOR UPDATE`, no retry loop. The scope's single-writer DO
   *is* the lock. This is the most demoable property Substrat has.
3. **The engine generalizes past its first vertical.** The same `engine-booking` runs a
   padel club and a hairdresser (different vocabulary, capacity, and duration model), and
   composes with `engine-workorder` for a bike shop's drop-off + repair.
4. **The outbox is a real seam.** Club events leave via `_substrat_outbox` and feed an
   out-of-kernel consumer (the player tier), without any cross-scope read.

## 2. Shape: racket club as v1, salon as the reuse proof

**v1 demo** = "RallyPoint": a padel/tennis club — courts, open matches, memberships,
coaches. **v2 skin** = "SalongTid": a hairdresser running the *same* engine with
service-derived durations and per-stylist resources. The bike shop is a third, cheaper
proof: the existing `CykelService` skin gains a drop-off booking, demonstrating
`booking` + `workorder` composed in one vertical.

## 3. Tenancy setup

- **Tenant = the club operator**; **scope = the venue** (a club with two locations is one
  tenant, two scopes). Demo data: **two tenants × two scopes** — RallyPoint AB (Solna +
  Nacka), Padelcenter Väst AB (Göteborg + Mölndal) — giving the cross-tenant attack demo a
  victim, matching `fsm`.
- **Critical scoping constraint** ([booking-social.md §3](../../../docs/design/booking-social.md)):
  a resource's *entire* calendar must live in one scope. All of a venue's courts are in
  that venue's DO. Never split one court across scopes — that reintroduces distributed
  locking and forfeits the single-writer guarantee.
- Principals: a club admin (tenant-level role), a receptionist at both venues, a
  receptionist at exactly one, a coach (sees own lessons only), and a **player** — who is
  *not* a principal but an opaque customer ref with an entity-narrowed grant (§9).

## 4. Decomposition of the club-manager feature set

| Capability | Layer | Demo scope |
|---|---|---|
| Court calendar, reservations, no double-booking | **Engine `engine-booking`** | v1, core |
| Court management (create / edit / deactivate) | **Engine** `manage-resources` + **vertical** screens | v1, admin portal |
| Club + court opening hours, closures | **Vertical** (§4.1) | v1 — weekly schedule + exceptions |
| Open matches (join, fill-or-cancel) | **Engine** (conditional confirm) + **vertical** (level rules) | v1, **the showpiece** |
| Slot durations (60/90/120) + start-time grid | **Vertical** | allowed durations per court + 30-min grid |
| Pricing rules by court / day / time / **duration** | **Vertical** | price-rule table + pricing hook at confirm |
| Memberships (tiers, discounts) | **Vertical** | one tier + a discount rule |
| Split payment ("pay your share") | **Engine `engine-invoicing`** | v1 — the star-topology showpiece |
| No-show → charge → debt blocks booking | **Vertical** policy over engine events | v1, stretch |
| Coaches + private lessons | **Vertical** (a resource kind) | resource kind `coach`, one lesson |
| Leagues, tournaments, classes | **Vertical**, deferred | out of v1 |
| POS / terminal sales | **Connector**, deferred | out |
| Analytics / occupancy reports | **Vertical** read models | one occupancy view |
| Staff roles & per-section permissions | **Kernel** | roles table (§9) |
| Player app, chat, level rating, "clubs near me" | **Out-of-kernel consumer** (§10) | stubbed seam only |

### 4.1 Court & venue administration (admin portal)

**Two levels of hours**, because they answer different questions:

- **Club hours** — the venue's weekly schedule (Mon–Fri 07:00–23:00, Sat–Sun 08:00–22:00).
- **Court hours** — an optional *narrowing* for one court: an outdoor court closing earlier
  in winter, or a court held for coaching 09:00–12:00.

> **Effective bookable window = club hours ∩ court hours − closures.**
> Court hours **narrow, never widen** — a court cannot be open while the venue is shut.
> Enforce that on write, or the two tables will disagree and the calendar will lie.

Hours are stored as **local wall time + the venue's IANA zone** (per
[engine-booking.md](../../../docs/design/engine-booking.md) D-B, local intent is vertical
territory) and materialized to instants when querying — so 07:00 stays 07:00 across a DST
boundary.

Conventions to fix **before the first migration** (append-only, so these are expensive later):

- **Past midnight** — a club open 07:00–01:00 stores `closes_at < opens_at`, meaning "next
  day". Decide the convention once; naive comparison silently truncates the late hours,
  which is exactly the padel prime-time slot.
- **Closed days** — an explicit `closed` flag beats a missing row: absence is ambiguous with
  "not configured yet".

**Closures & maintenance — two mechanisms, deliberately:**

- **Structural / recurring** (winter hours, a standing coaching block) → the hours tables.
- **Ad-hoc** (resurfacing, a private event, a burst pipe) → **an ordinary reservation** with
  an internal `party_ref` and no participants. This reuses the §6 overlap invariant exactly,
  blocks the slot for free, and shows on the club calendar with no new mechanism.
  Recommended over a parallel "blackout" table — a second way to occupy a court is a second
  thing that can disagree with the first.

**Availability stays the engine's, filtered by the vertical.** `availability()` returns raw
free intervals between reservations — left alone it would happily report 03:00 as bookable.
The vertical passes the effective window as the `from`/`to` bounds (or intersects after),
keeping the engine policy-free and consistent with D-B.

**Screens** (detail in `views.md`): courts list (name, kind, capacity, active); court detail
(hours override, allowed durations, price rules); club settings (weekly hours, closures and
holidays); calendar with blocks.

**Permissions**: court CRUD is the engine's `booking:manage-resources`; venue hours and
closures are vertical config needing their own key (`rally:manage-venue`). A new key means
it lands in the **permission-diff human checkpoint**.

## 5. `engine-booking`

The primitive ([booking-social.md §2](../../../docs/design/booking-social.md)):

> a **resource** held over a **time interval**, with the invariant that concurrent
> allocations never exceed the resource's **capacity** over any overlapping interval.

- **Tables**: `booking_resources`, `booking_reservations`, `booking_participants`.
- **Invariants (what the engine *is*)**:
  1. **No overallocation** — the sum of live allocations for a resource over any instant
     never exceeds its capacity. Exclusive booking is capacity = 1.
  2. State machine, no skips:
     `held → confirmed → in_service → completed`, plus `held → expired`,
     `confirmed → cancelled | no_show`.
  3. `held` carries a mandatory `expiresAt` — a hold is never permanent.
  4. Append-only participants, bound to a non-terminal reservation.
  5. Every mutation emits a fat event; every operation checks a permission.
- **Permissions**: `booking:create|read|hold|confirm|cancel|complete|manage-resources`.
- **Emits**: `booking.held|confirmed|expired|cancelled|completed|no-show`,
  `booking.participant-joined|left`, `booking.match-played` (v1 schemas).
- **Consumes**: nothing (leaf producer).
- **Vertical extension points**: resource `kind` vocabulary (court / stylist / bench),
  duration model (fixed slot vs service-derived), capacity, the **pricing hook** consulted
  at confirm, and the **fill policy** (§7).

### Why `booking` is its own engine, not part of `workorder`

The slot-allocation invariant is genuinely distinct from a work-order lifecycle, and the
bike shop wants **both** composed (drop-off = booking, repair = workorder). Folding
booking into `workorder` would force every reservation domain to carry work-order
vocabulary it has no use for. Star topology holds: they never import each other.

## 6. Locking & consistency — the demo's sharpest moment

A scope = one DO = one serialization domain. Every booking touching a court flows through
that venue's single writer, so "check free → write" is one uninterleaved transaction.
**There is no race to lock against.** The scenario test fires two concurrent
`confirm` calls at the last free slot; one wins, one gets `SlotUnavailable` — with no
locking code anywhere in the engine.

- **Soft holds** = the `held` state + TTL. Expiry is **lazy** (a `held` row with
  `expiresAt < now` counts as free on the next attempt); a DO alarm is only added if live
  UI release is wanted.
- **Availability views** are eventually-consistent read models. The DO stays the arbiter:
  race for a slot the view showed free and the loser gets "just taken."

## 7. The open-match mechanic (the showpiece)

Worth building because it exercises the engine's hardest corner and is unlike anything in
`fsm`. Per the vendor's public behaviour:

- A player creates an open match; **the court is not reserved immediately**. The
  reservation sits in `held` with a fill target (2 for a single court, 4 for a double) and
  a deadline.
- Other players join; each pays their share. On reaching the target → **auto-confirm**.
  On hitting the deadline unfilled → **expire and release**, participants refunded.
- Level range: derived from the first joiner (a −0.25 / +0.75 band). A player outside the
  band may *request* a spot; existing participants must unanimously accept. **Vertical
  policy** — the engine only knows fill target and deadline.
- Cancellation: while unfilled, any participant may leave freely; once full, up to 24h
  before start. Both are **vertical policy** enforced over engine operations.
- No-show: reported by other participants → charged the court share → a debt that blocks
  further booking. Vertical policy composing `engine-invoicing`.

This maps cleanly: **`held` + fill-condition + deadline is exactly the conditional
confirmation the engine already needs for payment holds.** One mechanism, two products.

## 8. Composition with `engine-invoicing`

Split payment is the star-topology showpiece: `booking.confirmed` carries the participant
list and the resolved price (fat payload — the consumer never needs a cross-module read);
the vertical composes invoicing's in-scope functions in the *same transaction* to raise
one charge per participant. No-show charges and refunds ride the same path.

## 9. Roles & permissions (human checkpoint preview)

| Role | Holds |
|---|---|
| `club-admin` | all `booking:*`, pricing, memberships, reports |
| `receptionist` | `booking:create|read|hold|confirm|cancel`, no `manage-resources` |
| `coach` | `booking:read` narrowed to own lessons |
| *player* | **no role** — an entity-narrowed `CapabilityGrant` over their own reservations |

The player row is the important one: a consumer is **not** a principal with a role
([kernel-design.md §4.3](../../../docs/design/kernel-design.md)). This reuses the portal
shape `fsm` already proves — no new mechanism.

## 10. The player / social tier — explicitly out of the vertical

The cross-club player identity, connections, small groups, and level rating are **not part
of this vertical** and cannot be: they are keyed to a global player identity owned by no
tenant ([booking-social.md §1, §4](../../../docs/design/booking-social.md)). The demo ships
only the **seam**:

- `booking.match-played` emitted with participants as **global player refs**;
- one thin consumer draining `_substrat_outbox` into a "my bookings across clubs" read
  model — proving the event→projection loop without building the social network;
- a **match join-link** (capacity-bounded, expiring) to show the privacy-clean add.

Out of scope: global player search, feed fanout, contact matching, geo index.

## 11. Scenario (testrun outline)

1. Seed two tenants × two venues, courts, **opening hours**, price rules, one membership tier.
2. **Venue admin**: edit club hours and a court's narrowing override; a booking outside the
   effective window is rejected by the vertical before it reaches the engine.
3. Receptionist books a court (90 min) → `held` → `confirmed`; invoice raised.
4. **Concurrency**: two confirms race the last slot → one `SlotUnavailable`.
5. **Hold expiry**: a `held` reservation passes its deadline → slot free again.
6. **Maintenance block** (internal reservation) prevents booking that court, via the same
   overlap invariant.
7. **Open match**: create unfilled → 3 join → auto-confirm on the 4th, split charges.
8. **Unfilled open match** hits deadline → expire + refund.
9. Cancellation inside/outside the 24h window → policy accepts/rejects.
10. **Cross-tenant attack** from vertical code → fails at the boundary.
11. `booking.match-played` lands in the outbox consumer's cross-club read model.

## 12. Open decisions

1. **Capacity model** — first-class quantity-against-capacity (needed for 4-player matches
   and classes) vs boolean-exclusive. Leaning first-class; exclusive is capacity = 1.
   Retrofitting later is a frozen-payload `schemaVersion` bump.
2. **Where the fill policy lives** — engine (fill target + deadline, generic) vs vertical
   (level bands, unanimity). Proposed split above; confirm before scaffolding.
3. **Recurring bookings** (a weekly 19:00 court) — common in this domain, and it stresses
   the interval model. In or out of v1?
4. **Timezone/DST handling** for intervals — must be decided before the first migration.
5. Whether the salon skin ships in this milestone or follows as the reuse proof.
