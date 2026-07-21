---
'@substrat-run/demo-meridian': patch
---

**Meridian runs on Cloudflare — worker port, stages 0-1 (toward dynamic portal deployment).**

The first two stages of porting Meridian from its node/SQLite server to a deployable Cloudflare
Worker, so it can be provisioned dynamically from the control-plane portal like Callout:

- **Stage 0 — workerd-safe `provision.ts`.** `provisionMeridian`/`MODULES`/`ROLES`/`connectScrive`
  are extracted from the node-only `seed.ts` (which imports `node:fs`/`SqliteScopeHost`) into a
  `ScopeHost`-typed `provision.ts` the worker can import. `seed.ts` re-imports them; all existing
  tests still pass.
- **Stage 1 — the worker.** `src/worker.ts`: `defineScopeDO(MODULES)`, `hostFor` (modules +
  `registerScriveConnector` + a `SecretBox` when Scrive is configured), `POST /internal/provision`
  (`assertPlatformCall` → `provisionMeridian`, the K-31 handshake), a generic `/api/invoke`
  (dev-header auth for now), and a **`scheduled()` Cron handler running `runPlatformSweep`** — the
  poll-path timer the node runtime got from `setInterval` (#96), with no Callout precedent. Plus
  `tsconfig.worker.json`, `wrangler.jsonc` (DO bindings, migrations, cron), and the
  `adapter-cloudflare` + `@cloudflare/workers-types` deps.

Verified on real `workerd` (`wrangler dev`): fail-closed provisioning (403 without the platform
secret), provision (201), `hr/define-leave-type` + `hr/create-employee` + `protocol/list-templates`
(200) on DO SQLite, and the scheduled sweep (200).

The port also surfaced a real DO-portability bug: `hr_absence_ledger`'s `0001-init` had an inline
comment containing a semicolon, which the CF adapter's naive migration `split(';')` truncated
("incomplete input") — better-sqlite3 exec'd the whole blob on node and never showed it. The
comment is de-semicoloned here; the adapter splitter fragility (and the adapter divergence behind
it) is filed for a separate fix + contract test.

**Stage 2 — Better Auth on D1.** End-user identity/credentials/sessions in a Cloudflare D1
(`AUTH_DB`) via `drizzle-orm/d1` (`auth.ts` — the workerd twin of the node `auth-node.ts`), with
`auth-schema.ts` + `migrations/0001_better_auth.sql`. The worker mounts `/api/auth/*` and resolves
each request through Meridian's existing runtime-agnostic `betterAuthAdapter` (session →
`resolveIdentity` → `PrincipalId`), falling back to the gated dev-header. An authenticated user
with no linked identity resolves to nobody; `POST /internal/link` (platform-gated) binds a login
to a principal — how a provisioned instance's owner becomes usable. Verified end to end on real
`workerd`: provision → sign-up → unlinked session 401 → link → the session resolves to the owner
`via: better-auth` → an authenticated `hr/*` invoke succeeds on DO SQLite.

**Incomplete:** Stage 3 (portal/router wiring) and Stage 4 (SPA assets) remain.
