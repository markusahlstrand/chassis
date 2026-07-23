---
'@substrat-run/dashboard': minor
---

**A failed create is loud, not a silent `provisioning`.** When provisioning didn't
complete (the vertical refused, a hostname wouldn't bind, the shared plane was
unreachable), the app row was left at `provisioning` forever — indistinguishable from
"still coming up".

- **`dashboard/mark-app-failed`** op — `createApp` marks the row `failed` when the effect
  throws (guarded to only move a `provisioning` row), then re-throws the original error.
- **The dashboard surfaces it** — `createApp` in the UI now catches, reloads (so the
  `failed` row shows), and shows an error toast with the reason instead of an unhandled
  rejection.

Verified: dashboard suites pass (12), including a new test that a create whose effect
throws leaves the row `failed`, not `provisioning`.
