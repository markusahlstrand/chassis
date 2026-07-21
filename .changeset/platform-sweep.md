---
'@substrat-run/kernel': minor
---

**`runPlatformSweep` / `startPlatformSweeper` — the scheduler's unit of work (#96, poll path,
Design A).**

`drainDue` (the executor retry driver) and the connectors' reconcile sweeps both landed with no
caller on a timer. This is the one that calls them:

```ts
const report = await runPlatformSweep(host, {
  actor,
  fetch,                                              // sanctioned egress for sweeps
  sweepers: { scrive: sweepScriveReconciliations },   // provider → sweeper, INJECTED
});
```

One pass drains every active scope's due deliveries (`listScopes({ status: 'active' })` →
`drainDue`) and reconciles every live connection (`listConnections` → `sweepers[provider]`).
Provider-agnostic — it imports no connector; the deployment that owns the call site assembles the
sweeper map. Robust by construction: bounded concurrency (`concurrency`, default 8) so one slow
provider cannot delay the fleet, and a failure on any one scope or connection is recorded in the
report and stepped over, never allowed to sink the pass. Revoked connections and providers with
no sweeper are skipped and counted. `drainRetries: false` sweeps connectors only.

`startPlatformSweeper(host, { intervalMs, … })` drives it on a self-rescheduling timer for a
long-lived (node) runtime — non-overlapping by construction, since the next pass is scheduled only
after the current one settles; returns a `stop()` handle. A Cloudflare runtime calls
`runPlatformSweep` directly from `scheduled()`/an alarm instead.

Tested with fakes (enumeration, dispatch-by-provider, error isolation, concurrency bound, timer
overlap/stop) and end to end against the SQLite adapter with the real Scrive connector — a
signature completes through the driver, nobody handing it the instance id.

See [docs/design/scheduler.md](../docs/design/scheduler.md). The remaining step is a call site in
a deployed vertical (the control-plane worker is deliberately NOT it — its `ScopeDO` is
module-less; the sweep must run in the vertical's own runtime).
