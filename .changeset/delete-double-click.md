---
'@substrat-run/dashboard-web': patch
---

**Delete app tolerates a double-click.** A fast second click re-sent `DELETE` for an
already-deleted app → `list-apps` no longer had it → 404 "app not found" (an error
toast, though the first delete succeeded). The handler now guards against a concurrent
in-flight delete (an `in-flight` ref) and treats a 404 as the desired end state (already
gone) rather than an error.
