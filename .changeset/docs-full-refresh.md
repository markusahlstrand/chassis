---
'@substrat-run/docs': minor
---

**Docs: catch the site up to the self-serve-deploy era.** The site had drifted ~40 commits behind
— the whole CLI / deploy / platform-app / scope-local-permissions arc was undocumented, and a
handful of pages had gone stale against the code.

New pages:

- **Guide → Deploying a vertical** — the `substrat` CLI (`login`, `push`), the push-lands-pending /
  admission-gates-serving model, and the laptop → console → router path. Wired into getting-started
  and running-locally.
- **A Platform section** — the four surfaces that run the verticals: the shared **control plane**,
  the operator **console**, the environment **router**, and the tenant-facing **dashboard**.
- **Three missing vertical pages** — **Callout** (the canonical reference vertical, previously
  undocumented), **Handlebar**, and **Kallkälla/shop** — plus links from the verticals index.
- **`@substrat-run/oidc-rp` reference** — the shared AuthHero relying party behind the platform
  apps.

Rewrites for landed architecture:

- **Scope-local permissions** — `concepts/permissions.md` and the `adapter-cloudflare` reference now
  describe projection-on-write and the control-plane-optional host mode, replacing the old
  per-request-control-plane-read model. The adapter Status section drops the router / scope-local
  claims it listed as unbuilt (both shipped).
- **Auth** — `concepts/identity.md` records that the platform apps consolidated onto AuthHero OIDC
  while demos stay Better Auth.

Corrections: Scrive is documented as **published `0.1.0`** (was "private, unpublished");
`protocolContentHash`'s real signature (no `ctx`); the **invites** engine added to the engines
overview; the booking state machine's true terminal transitions and two missing in-scope functions;
`facility` / `number` added to two documented event payloads; the `what-is-substrat` status table
refreshed with every engine, demo, connector, the CLI, and the platform surfaces.
