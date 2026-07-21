---
'@substrat-run/connector-scrive': minor
---

**Publish `@substrat-run/connector-scrive` — the first released version.**

The connector is no longer `private`. It has been unpublished-while-incomplete since it was
written; both halves now exist and are tested — outbound dispatch (verified against the real
`api-testbed.scrive.com`), and the return path that records a completed signature back into the
scope through the #97 authority seam (`reconcileScriveDispatch` / `sweepScriveReconciliations`,
driven by `runPlatformSweep`). So it ships.

Standard publish config, matching the other packages: `publishConfig.access: public`, `files:
["dist"]`. It stays a `0.x` release, which already signals an unstable surface — two honest
caveats a consumer should know, both documented in the README:

- **A deployment must schedule the poll.** The connector provides `sweepScriveReconciliations`;
  the consuming vertical calls it on a timer (`startPlatformSweeper` on node, a Cron / DO alarm on
  Cloudflare). Without that, dispatch works but signatures are never recorded back.
- **The live BankID signing round-trip is unverified.** `se_bankid`-to-sign is disabled on the
  testbed account, so the outbound lifecycle is proven live but the actual signature (and Scrive's
  real signed-`get` party shape) has only been exercised against `ScriveMock`. The reconcile fails
  closed on a shape mismatch, so a wrong assumption cannot mis-record — it skips, visibly.
