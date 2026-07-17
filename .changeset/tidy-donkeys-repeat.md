---
"@substrat-run/engine-invoicing": minor
---

Fix two defects, and correct `underlag-exported` to carry a real amount.

**BREAKING for consumers of `invoicing.underlag-exported`.** It is now
**schemaVersion 2**, and `total` is `Money` (`{ amount, currency }`) rather than
a bare amount string — a number with no currency, on the one event an accounting
connector consumes. `demos/fsm/spec/testrun.md` always specified `total: Money`,
so this is the code meeting its own spec. Read `total.amount` and
`total.currency`.

This is a **replace, not a dual-emit**, deliberately departing from the usual
deprecation-window rule. Consumer dispatch keys on event *type* alone — the
`schemaVersion` in a manifest's `consumes` is not used for routing — so emitting
v1 and v2 together would deliver *both* to every consumer of the type, and a
connector could invoice the same underlag twice, silently. A replace fails
loudly instead: a v1 consumer's strict parse rejects v2 and dead-letters. The
underlying contradiction is logged as kernel-design open question 16.

**Fixed: totals summed across currencies.** `underlagTotal` used `addDecimal`,
which ignores currency, so 100 SEK + 100 EUR totalled `200` — not a rounding
bug but a financial artifact stating a meaningless number, while contracts'
`addMoney` throws on exactly that mismatch. An underlag is now one document in
one currency, enforced at write time: a delivery whose lines disagree is
rejected and dead-lettered, so no unreadable document is ever created. (Read-time
rejection would have left a permanently poisoned underlag.)

**Fixed: `onWorkOrderCompleted` was not idempotent.** It had no source-id guard
while `onCommerceOrderPlaced` did, so a replayed completion duplicated its
billable lines — double-billing the customer. Both consumers now dedup on the
source order, which is what the docs already promised for both.

Also: the engine now has tests. It had none — 23 covering the consumers,
export immutability, the currency and idempotency guards, dead-lettering, and
the v2 payload.
