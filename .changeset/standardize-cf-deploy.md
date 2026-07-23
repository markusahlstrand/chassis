---
"@substrat-run/control-plane": patch
"@substrat-run/router": patch
"@substrat-run/docs": patch
---

**Standardize the deploy script name to `cf:deploy` across all deployable workspaces.** control-plane,
router, and docs used `deploy`, which collides with pnpm's built-in `deploy` command (`pnpm deploy` →
`ERR_PNPM_NOTHING_TO_DEPLOY`, needing `pnpm run deploy`). They now use `cf:deploy` — matching dashboard,
the demos, and the external-vertical example — so `pnpm cf:deploy` just works. Docs references updated.
