---
'@substrat-run/control-plane-api': minor
'@substrat-run/contracts': minor
'@substrat-run/control-plane': minor
'@substrat-run/cli': minor
---

**Builder writes — self-serve deploy, end to end (builder-plane.md Phase 3).** A tenant user
can now `substrat login`, `push`, and `promote` their own verticals without staff, and the
control plane forms the `<tenantSlug>/<name>` id they never type. This makes the Phase-2
authz mechanism live.

- **Prefixed vertical ids (`verticalSlug`)** — a new contracts brand allows an optional single
  `<tenantSlug>/` prefix; the registry schemas use it. A builder pushes a **bare** `--slug`;
  the control plane prepends their authenticated tenant's slug, so two tenants can each own a
  `helpdesk` with **no global claim race** (Vercel-style non-scarce namespace). Platform
  verticals stay bare. `deploymentRefFor` already flattens the `/`; hostnames never carry it.
- **The live builder reader** (`oidcBuilderReader`, control-plane worker) — the same signed
  session the CLI/console carries resolves via the shared identity directory to the tenants a
  user belongs to, narrowed to the selected one → a `(actor, tenantId, tenantSlug)` builder
  principal. **No vetting roster**: self-serve is the point; a user with no workspace is
  declined (sign up in the dashboard first). The audited actor is a stable
  `PlatformActorId` derived from the OIDC subject.
- **`effectiveSlug`** threads the prefix through every builder vertical route
  (`control-plane-api`), so ownership, filtering and dispatch all key on the real id.
- **`GET /api/auth/whoami`** — the session's user + the tenants it can build for. The CLI
  calls it on `login` to store a default workspace (prompting when there are several).
- **CLI** — `substrat whoami`; `substrat promote <slug> --channel dev|staging --version <id>`
  (a builder self-serves non-prod; prod + admission stay staff, model B); `--tenant` /
  `SUBSTRAT_TENANT` / a stored default, sent as `x-substrat-tenant` with a browser session.

Scope: no auto-bootstrap of a workspace from the CLI (a builder signs up once in the
dashboard, then the CLI just works) — flagged as a follow-up.

Verified: control-plane-api (71) incl. the reworked builder matrix under prefixing (each
tenant gets its own namespace, no collision), control-plane worker (17) incl. a live
end-to-end builder path (bare push → `acme-co/helpdesk`, whoami, fail-closed no-workspace),
adapter suites (147 + 153) and `pnpm -r typecheck` all pass.
