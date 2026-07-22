-- The CP-less vertical's identity binding (scope-local-permissions.md Phase 3).
-- With no control plane to hold the id→principal directory, the Better Auth `user`
-- row does: `principal_id` is the kernel PrincipalId a login resolves to, set on the
-- user's first login (worker.ts `d1IdentityDirectory`) and read on every one after.
-- NOT a Better Auth field — the vertical's own column, nullable until first login.
-- Apply locally with: wrangler d1 migrations apply substrat-fsm-auth --local
ALTER TABLE user ADD COLUMN principal_id TEXT;
