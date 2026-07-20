---
'@substrat-run/router': patch
---

The router retries a transient dispatch failure once, for bodyless requests only.

Verifying K-28 turned up a second finding: a freshly-deployed user worker is not
instantly reachable everywhere. One scope got `Worker not found.` for ~15s while
sibling scopes on the same script succeeded — its Durable Object had placed in a colo
the script had not propagated to — and it healed on its own.

There is no propagation-complete signal to wait for, so this is not a delay. It is one
bounded retry, which also survives being wrong about the cause: the colo explanation is
an inference from the symptom, not something Cloudflare documents.

Bodyless requests only. A retry is safe only when the first attempt provably had no
effect, and replaying a POST that already reached the vertical would run the mutation
twice.
