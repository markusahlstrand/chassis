---
'@substrat-run/boundary-lint': patch
---

Treat `page.ts` as harness. A served SPA (an HTML/JS string the worker returns) is
edge wiring, not module code reachable from a `ModuleRegistration` — its `fetch` is
browser code. Added to `DEFAULT_HARNESS` alongside `worker.ts`/`routes.ts`, so R3
(no network in module code) no longer false-positives on a vertical's served page.
