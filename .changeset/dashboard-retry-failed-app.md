---
"@substrat-run/dashboard": patch
---

**Wire the "Retry" action on a failed app — it re-provisions for real instead of a placeholder toast.**

The Retry link on a `failed` app card was a stub (`setToast({ title: 'Retry not wired yet' })`).
It now calls a new `POST /api/apps/:scopeId/retry`, which best-effort tears down the failed
attempt and re-provisions fresh under a new scope with the same vertical + name, via the proven
`createApp` path. A retry that still can't come up re-marks the row `failed` and surfaces the
**real** provisioning error, so the button re-tries for real and stops hiding why an install
failed. The re-provision logic is a testable `retryApp` in `provision.ts` (composing
`deprovisionApp` + `createApp`); a regression test drives failed-install → retry → a fresh live
scope. Only a `failed` app is retryable, and only the caller's own (list-apps is tenant-scoped).

Note: this fixes the *recovery* path, not the reason a Meridian install fails in connected mode —
the shared control plane provisions via the `substrat-verticals` Workers-for-Platforms dispatch
namespace, and Meridian has not been deployed there / promoted to a prod version yet. Until it is,
Retry will surface that provisioning error rather than succeed.
