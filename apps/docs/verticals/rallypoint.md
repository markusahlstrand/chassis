# RallyPoint (padel club)

`demos/rally` — a **racket-club booking platform**: courts, availability, open matches,
prepaid credit and subscriptions, across several venues, in **two apps over one API** — a
mobile app for players and a desktop console for club staff.

## Overview

RallyPoint is the demo that proves the platform holds up on a **second invariant shape**.
Every other vertical composes a *state machine* — an order that moves `planned → completed`.
A reservation is not that. It is **allocation against capacity over an interval**, and the
thing that must never happen is two people holding the same court at the same time.

It is interesting for four reasons the other demos can't show:

- **The lost race, with no locking code.** Two people book the last slot; one is refused with
  `SlotUnavailable`. There is no `SELECT … FOR UPDATE`, no retry loop, no lock anywhere in
  [the engine](/engines/booking/) — because a scope is a single Durable Object, so the check
  and the write that follows it never interleave. This is the clearest demonstration in the
  repo that the DO-per-scope choice buys something concrete.
- **Atomicity across two concerns, for free.** Paying for a court from a prepaid balance
  debits a ledger *and* confirms a reservation in one transaction in one scope. "Charged but
  not booked" and "booked but not charged" are both **unrepresentable**, not merely unlikely
  — the expensive part of this feature everywhere else.
- **A consumer who holds no role at all.** A player is not a principal with a role. They hold
  scope-wide grants for things that are genuinely public at a club (see what is free, take a
  free court) and **entity-narrowed** grants for everything touching a booking that already
  exists. Widening the latter to the scope would hand every player the club's entire book.
- **Multi-venue tenancy that the UI has to respect.** One tenant runs two venues; a
  tenant-level admin reaches both, a receptionist is pinned to one — and *the console shows
  no venue switcher to staff who have only one*, because reachability is the permission model
  answering rather than a UI preference.

## At a glance

| | |
|---|---|
| **Package** | `demos/rally` (private) |
| **Tenancy shape** | 2 tenants — RallyPoint AB (Solna + Nacka scopes) · Padelcenter Väst AB (the cross-tenant attack victim) |
| **Engines composed** | [`booking`](/engines/booking/) · [`invoicing`](/engines/invoicing/) |
| **Own tables** | `rally_venue` · `rally_members` · `rally_wallet_entries` (append-only) · `rally_credit_packs` · `rally_plans` · `rally_subscriptions` · `rally_courts` · `rally_venue_hours` · `rally_court_hours` · `rally_closures` · `rally_price_rules` · `rally_bookings` · `rally_matches` |
| **Roles** | `club-admin` (tenant) · `receptionist` / `coach` (scope) — players are grants, not a role |
| **Permission surface** | [`PERMISSIONS.md`](https://github.com/substrat-run/substrat/blob/main/demos/rally/PERMISSIONS.md) — 15 keys, 3 roles |
| **Apps** | player (mobile, `:5277`) · manager console (desktop, `:5278`) over one API (`:8877`) |
| **Status** | demo seed — the social/player tier and payment rail are deliberately out of scope (below) |

## Engines composed

### `booking` — the allocation invariant

The vertical never checks whether a court is free. It validates its **own** rules, resolves
its **own** price, hands the engine an absolute interval, and lets the engine arbitrate:

```
rally/book-court
  ├── vertical: is the club open? is this duration offered on this court?
  ├── vertical: which price rule wins, and what does it cost?
  ├── ENGINE:   holdReservation(…)  ← throws SlotUnavailable if taken
  └── vertical: record price in rally_bookings, keyed by the engine's id
```

A vertical that checked for a clash first would be doing it wrong — it cannot do so
correctly, and the engine already does.

### The orchestration moment: paying from a balance

`rally/confirm-booking` composes the engine's `confirmReservation` and the vertical's own
ledger debit **in one transaction**. If the balance is short, the whole thing rolls back —
the reservation stays `held` *and* the ledger stays empty. There is a test that asserts
exactly that, because it is the property the design claims.

### What is vertical, and emphatically not engine

| Concern | Lives in | Why |
|---|---|---|
| Timezones, opening hours, DST | vertical | the engine takes instants and does no calendar arithmetic |
| Pricing, seasonal rules | vertical | the engine never learns what a slot costs |
| Level bands, cancellation windows | vertical | the engine knows only *fill target* and *deadline* |
| Wallet, credit packs, subscriptions | vertical | [commerce-gaps §4.6](https://github.com/substrat-run/substrat/blob/main/docs/design/commerce-gaps.md) — a subscription engine designed off a demo wishlist is the exact failure mode D-27 prevents |

Two domain details worth stealing:

- **Floodlights are priced by season, not by the clock.** A night surcharge exists because
  someone pays for the lights, and Stockholm sunset moves from ~14:45 in December to ~22:00
  in June — so a fixed "after 17:00" rule bills for lights in June daylight and misses the
  December afternoon. Price rules carry a date range, and a season outranks a time of day.
- **A subscription is a wallet topped up on a schedule.** One mechanism, not two. The
  recurrence is a Workflow's job; the credit and the cursor advance happen in one transaction.

## The cast & what's denied

| Who | Holds | Cannot |
|---|---|---|
| **Astrid** — klubbchef | `club-admin` at **tenant** level | nothing at Padelcenter Väst; her role is her own tenant's |
| **Ravi** — reception, Solna | `receptionist` **scoped to Solna** | re-cut hours, create courts, read roles — and gets no venue switcher at all |
| **Nils** — coach | `coach` | book anything; he reads the calendar and writes nothing |
| **Elin / Johan** — players | **no role.** Scope-wide `rally:browse` + `booking:hold`; entity-narrowed `booking:read`/`confirm`/`cancel` on their own member record | read the club's book, the member roster, another player's wallet |
| **Rutger** — another company's admin | `club-admin` in his own tenant | anything here — and the refusal differs by layer (below) |

Two of these are worth reading closely.

**The coach grant is deliberately broad** — plain `booking:read` is the *whole* venue
calendar, member names included, not just his own lessons. Reviewed and accepted at the
permission checkpoint; narrowing it needs a per-coach entity grant, and the line to re-open
it on is a club running independent coaches who must not see each other's business. A test
pins the breadth, so narrowing it later is a visible change rather than a silent one.

**The attacker is refused differently depending on where he knocks.** In-scope he names the
`(tenant, scope)` pair himself, gets it wrong, and gets `unknown scope`. Through the HTTP
surface the *server* supplies the pair from its venue table, so he cannot mis-pair it — he
reaches a real scope and is refused by the permission model instead. A stronger answer, one
layer further in.

## The app

Two surfaces, one API. The split is chrome and audience, never a second source of truth.

**Player app** (mobile, 402px) — the signature interaction is the **slot picker with fit
dots**: each start time shows which durations actually fit the gap (● 60 · ●● 90 · ●●● 120),
so no tap can dead-end. Choosing a duration *commits*; when only one fits, tapping the time
commits outright. Then a hold countdown that turns urgent under a minute and states plainly
that nothing was charged if it lapses. A lost race never shows a bare error — it offers the
nearest alternatives.

**Manager console** (desktop, 1440px+) — a resource-grid calendar, courts as columns and time
as rows, with a peak band, a now-line, and cell states that are each border + fill + icon +
label, **never colour alone**: confirmed, held-with-countdown, open match filling, maintenance
stripes, outside-hours hatch, expired, past. Cells render `effectiveState`, so a lapsed hold
never shows a countdown ticking past zero. The booking drawer keeps every typed value on a
rejection and offers one-tap alternatives.

Both are built from a high-fidelity design handover kept in
[`demos/rally/spec/design/`](https://github.com/substrat-run/substrat/tree/main/demos/rally/spec/design).

## Run it

```bash
pnpm --filter @substrat-run/demo-rally dev
# API      http://localhost:8877
# player   http://localhost:5277
# console  http://localhost:5278
```

The executable spec is two suites, **34 tests**:

- `test/scenario.test.ts` — the invariants, called directly: the lost race, lazy hold expiry,
  seasonal pricing to the öre, wallet atomicity, portal isolation, the cross-tenant attack.
- `test/flows.test.ts` — the same journeys walked through the **real HTTP routes**, ending
  with a guard that fails if any registered route was never exercised. That guard exists
  because every bug this demo shipped was a wiring bug — an operation with no route, a link
  nothing read, a button with no path behind it — and a test that reaches for `ctx` is
  structurally blind to all of them.

## Deliberately out of scope

- **The cross-club player tier.** Connections ("players I've played with"), groups, and a
  portable rating are keyed to a *global* player identity owned by no tenant. A club's scope
  cannot answer "which other clubs does she play at", and must not be able to. Those live in
  a downstream tier fed by the event outbox — see
  [booking-social.md](https://github.com/substrat-run/substrat/blob/main/docs/design/booking-social.md).
- **A payment rail.** Buying credit currently mints balance without charging anything; the
  money is imaginary. Stripe Connect is a connector, and connectors are a framework this repo
  has specified and not yet built.
