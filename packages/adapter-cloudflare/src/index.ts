/**
 * `@substrat-run/adapter-cloudflare` — the Durable-Object scope host (D-14).
 *
 * WORK IN PROGRESS (milestone 1: turn the shared contract-test suite green in
 * workerd against real Durable Objects). Landing incrementally:
 *   - [x] step 0 — spike: DO SQLite transaction semantics resolved
 *   - [ ] ScopeDO        — one scope = one SQLite-backed DO
 *   - [ ] ControlPlaneDO — the directory (tenants/scopes/roles/entitlements/audit)
 *   - [ ] CloudflareScopeHost — the coordinator facade implementing ScopeHost
 *
 * The adapter boundary is the scope-host contract (§5.7): everything above it is
 * the same kernel + contracts + modules the pure adapter runs, unchanged.
 */
export { OperationQueue } from './serialization.js';
export { doScopedSql } from './sql.js';
