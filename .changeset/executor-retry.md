---
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
---

**Executor deliveries retry, back off, and dead-letter instead of escaping the operation.**

`ExecutorHandler` is the only outbound seam in the system. That was fine while the only
executor wrote to the local directory; it stops being fine the moment one makes an HTTP
call, which is the most likely thing in the system to fail transiently.

Three specific defects, all fixed:

- **A throwing handler escaped `invoke()` after the transaction committed.** The caller
  was told their work failed when it had not. A delivery failure and an operation failure
  are different facts, and only the second belongs in the caller's result.
- **A poison event wedged the queue permanently.** The scan is `ORDER BY o.id`, so the
  failing event was re-selected first on every drain and executor *N+1* never ran while
  *N* threw.
- **Nothing retried on its own.** With no timer anywhere, a failed delivery was retried
  only if someone happened to invoke another operation on that same scope — and nothing
  reported that it hadn't.

New surface:

```ts
registerExecutor(id, eventType, handler, retry?: ExecutorRetryPolicy)
drainDue(tenantId, scopeId): Promise<ExecutorDrainReport>
executorDeadLetters(tenantId, scopeId): Promise<ExecutorDeadLetter[]>
```

Retry policy is **per executor** rather than a host constant: the defaults suit a
directory write, and a connector making an outbound call wants a longer tail.
`_substrat_deliveries` gains `attempts` and `next_attempt_at`, added by `ALTER` on both
adapters — the defaults read as "terminal", which is correct for every row already there.
Consumer dispatch is untouched.

Behavioural change worth noting: an operation can now report success while its external
effect has not happened yet. That is the correct semantics for an outbox, and it is what
the path was already doing silently — the difference is that failures are now recorded,
retried, and readable instead of being thrown at whoever held the request.

Prerequisite for the integrations hub ([`docs/design/connections.md`](docs/design/connections.md)).
Scheduling `drainDue` from a cron trigger or Durable Object alarm is not included here.
