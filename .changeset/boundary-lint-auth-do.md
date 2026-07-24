---
'@substrat-run/boundary-lint': patch
---

Recognize `auth-do.ts` as harness. A Durable Object that wires an authentication adapter
(Better Auth over the DO's own SQLite) is the workerd analogue of the already-exempt
`auth-node.ts` — edge auth wiring, not module code — so its `fetch` request-interface method
is no longer mistaken for a network call by the R3 rule.
