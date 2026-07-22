---
'@substrat-run/boundary-lint': patch
---

Treat `page.ts` and `oidc.ts` as harness. A served SPA (an HTML/JS string the worker
returns) is edge wiring, not module code reachable from a `ModuleRegistration` — its
`fetch` is browser code. `oidc.ts` is an OIDC relying party at the server edge (token
exchange, JWKS) — the same node/network-touching auth-adapter class as `auth.ts`.
Both added to `DEFAULT_HARNESS` alongside `worker.ts`/`routes.ts`, so R3 (no network
in module code) no longer false-positives on a vertical's served page or auth edge.
