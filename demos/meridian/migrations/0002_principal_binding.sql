-- The CP-less vertical's identity binding (scope-local-permissions.md Phase 3).
-- With no control plane to hold the id→principal directory, the Better Auth `user`
-- row does: `principal_id` is the kernel PrincipalId a login resolves to, bound by
-- /internal/link when a provisioned instance's owner is made usable (worker.ts
-- `d1IdentityDirectory`) and read on every login after. NOT a Better Auth field —
-- the vertical's own column, nullable until bound.
-- Apply locally with: wrangler d1 migrations apply substrat-meridian-auth --local
ALTER TABLE user ADD COLUMN principal_id TEXT;
