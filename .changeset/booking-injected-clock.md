---
'@substrat-run/engine-booking': patch
---

`effectiveState` is computed from the injected clock, never wall time.

`toReservation` defaulted `now` to `new Date().toISOString()`, so every caller that
forgot to pass the clock it had been handed silently used wall time instead. The engine
takes an explicit `now` precisely so behaviour is deterministic; the default quietly
opted out of it.

This is invisible until real time crosses a boundary the test data assumed, and then it
reads as flakiness rather than a bug — the suite went red hours after it was last green,
with nothing changed.

`now` is now required, so the compiler finds every caller. That turned up four
operations with no clock at all (`cancelReservation`, `startReservation`,
`completeReservation`, `markNoShow`); each takes an optional `now` like its siblings.
