---
'@substrat-run/adapter-cloudflare': patch
---

Cloudflare adapter: durable control plane

The coordinator's directory is now durable. `ControlPlaneDO` grew from the two-table
checker slice into the full directory — tenants, scopes, entitlements, the admin
audit log, identities, roles, and tenant-level tuples all in its SQLite (DDL and
error messages ported verbatim from the pure adapter). `CloudflareScopeHost` is now
a thin async router: it dropped the six in-memory directory maps and the
enqueue/drain machinery, and `await`s RPCs to the DO for every admin mutation,
lifecycle check, and read. It keeps only code-time registration bookkeeping in
memory and still routes scope-level tuples to the owning ScopeDO. The control plane
now survives a coordinator restart — the prerequisite for a stateless production
Worker. Both contract suites stay green (CF 43+1 skip, adapter-sqlite 50).
