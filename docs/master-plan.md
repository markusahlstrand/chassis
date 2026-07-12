# Chassis — Master Plan

> **The hard parts, hosted.**
>
> Working document. This is the canonical source; the operator narrative, the technical RFC,
> and any pitch material are derivatives of this file and go stale — this file doesn't.

Status: draft v0.1 · Last updated: 2026-07-12

Anonymized: **PropCo** = the anchor property-management company · **HouseCo** = the
house-building company · **POSCo** = the point-of-sale company · **MediaCo** = the
media-subscriptions venture · **the auth platform** = our existing open-source auth
product · **the FSM vendor** = the incumbent field-service-software vendor · **the kernel
owner** = the person owning kernel and engines. Public market vendors (competitors,
suppliers, platforms) stay named — they identify no one involved.

---

## 1. Thesis

AI has made building vertical B2B software fast and cheap — except for the parts that were
never about writing code: multi-tenancy, identity, permissions, integrations, data integrity,
audit, and GDPR. Those are exactly the parts that are catastrophic when wrong and that
LLM-generated code gets wrong most often.

Chassis is a hosted substrate that owns those hard parts and enforces them **at runtime** —
so that small teams (including non-engineers wielding AI tools) can build production-grade
vertical SaaS on top, at AI speed, without the speed being fatal.

We build the chassis. They build the vehicles.

## 2. The problem, with evidence

The "70% problem" is now industry vocabulary
([Osmani, 2024](https://addyo.substack.com/p/the-70-problem-hard-truths-about)):
prompt-to-app tools (Lovable, Bolt, Replit) get a product roughly 70% of the way, and the
remaining 30% — auth hardening, tenant isolation, error handling, integrations, compliance —
is professional work: published hardening offers run
[£1,495–4,995 fixed-price per app](https://www.originalobjective.com/software-development/vibe-coding-production-support),
and year-one true-cost analyses of running a vibe-coded prototype land at
[~$6k–32k](https://hatchworks.com/blog/gendd/cost-of-vibe-coding/). A cottage industry of
"vibe-code hardening" consultancies now exists whose audit checklists (missing RLS, broken
auth boundaries, no tenant isolation, no audit trail) read like our kernel spec in reverse.
Veracode's 2025 GenAI report puts OWASP Top-10 vulnerabilities in
[45% of AI-generated samples across 100+ models](https://www.veracode.com/blog/ai-generated-code-security-risks/);
Databricks' red team found generic "be secure" prompting cuts insecure output only
[~13–19%](https://www.databricks.com/blog/passing-security-vibe-check-dangers-vibe-coding) —
prompting is not enforcement.

We have a live case study in the friend group: multiple one-off internal systems built with
Lovable and other LLM tools across an operating portfolio (property management, POS,
house building). The builder himself expects them to fail at the exact moment a business
depends on them. He is right, and the failure list is enumerable — and it is the kernel.

The structural insight: **the layer where LLMs are weakest (tenancy, auth, migrations,
integrations, compliance) is the layer where mistakes are catastrophic. The layer where LLMs
are strongest (screens, forms, workflows, reports) is the layer where mistakes are cosmetic.**
Chassis puts humans and hard guarantees under the line, and AI velocity above it.

## 3. The three-layer model

Everything in this plan hangs off one architectural and commercial decomposition:

**Kernel** (Chassis proper). Everything that is true of every B2B SaaS and nothing that is
true of any particular one. Identity, nested tenancy, permissions, documents, integrations
framework, events/audit/reporting spine, module system, notifications, jobs, billing
entitlements, GDPR machinery, app shell. Owns **no domain entities** — no customer table,
no work-order table. Instead it offers attachment contracts (documents, comments, activity
timeline, custom fields, audit events) that bind to opaque `(entity_type, entity_id)` refs
the vertical defines.

**Engines**. Domain machinery shared across verticals but too domain-shaped for the kernel:
work orders + time reporting, scheduling, ticketing/ärende, protocol/checklist engine,
asset hierarchies, portal shells. Headless, versioned modules. Engines own **invariants**
(state machines can't skip states; time entries are append-only; signed protocols are
immutable; every mutation emits an event; every access passes the permission check).
Verticals own everything with a user's fingerprints on it: vocabulary, extra states, form
fields, triggers, UI, pricing logic, branschprotokoll content. Design test: **if a vertical
ever needs to fork an engine, the engine drew its line wrong.**

**Verticals**. The businesses. Branschmoduler, workflows, GTM, customer relationships.
Owned by whoever builds and sells them (initially: the friend's companies). Built at AI
speed on kernel + engines.

## 4. Why runtime enforcement is the moat

Every adjacent solution delivers guarantees as **conventions**: templates you copy
(MakerKit, ShipFast, Open SaaS), code generators that eject (Baseplate.dev — whose proudest
feature is "zero lock-in, no runtime dependencies"), or a BaaS whose enforcement primitive
is the very thing vibe coders misconfigure (Supabase RLS). Conventions erode with every
LLM edit.

Chassis inverts this. Generated vertical code **cannot**:

- reach another tenant's data — data access only exists as capability-scoped RPC into the
  owning scope's Durable Object, which validates the caller against its own ACL;
- leak tenants in reporting — the only analytical path is a query gateway that injects
  tenant predicates;
- call third-party APIs raw — credentials live in the integrations hub; verticals see only
  the connector interface;
- skip the audit log — events are emitted by the engine below the API surface, not by the
  calling code.

When the guarantees live below the API surface, it stops mattering who — or what — wrote
the code above it. This is a categorically stronger safety model than "prompt the LLM to be
careful," and it is the one property that survives model improvement: even a future AI that
writes flawless tenancy code doesn't solve the **trust** problem. Someone has to underwrite
that isolation, audit, and GDPR hold structurally. That someone is Chassis.

The two human checkpoints that stay non-negotiable even in a fully AI-driven vertical shop:
schema migrations and permission definitions get reviewed by a person. Everything else
iterates at AI speed with contained blast radius.

## 5. Architecture decisions

### 5.1 Tenancy: two levels, tree-shaped

The tenant is the business (förvaltningsbolag, retail chain, publisher); beneath it are
**scopes** (BRF customers, filialer, client companies, brands, clinics). Users belong to the
tenant, to a scope, or to several scopes with different roles; permissions are assignable at
either level with inheritance down the tree. This shape recurs in every known case (PropCo's
BRFs, POSCo's byrå feature, MediaCo's publishers/brands, dental chains) and incumbents
bolted it on late (the FSM vendor sells filial support as a paid add-on). Flat Auth0-style organizations
model it badly; native hierarchical scoping is a differentiator for the kernel and for
the auth platform as a product.

### 5.2 Storage: two shapes behind one contract

The kernel contract is `getScope(tenantId, scopeId) → RPC stub`; where the data physically
lives is the vertical's storage decision.

**Shape A — DO-per-scope with embedded SQLite as primary store.** The Durable Object *is*
the database (SQLite-backed DOs, 10GB/DO, PITR). Right for small, document-centric,
realtime-friendly scopes — our document-spaces product is the proving ground.

**Shape B — DO-per-scope as control plane fronting per-tenant D1.** DO holds hot state
(ACLs, entitlements, counters, locks) and mediates every access; storage stays in D1 for
read replicas (Sessions API), HTTP/wrangler ops tooling, export/backup, and >10GB headroom.
Right for the förvaltar-OS.

Granularity rule: **the DO maps to the consistency domain, not the tenant** — one
lightweight tenant-root DO (directory, membership, entitlements) plus one DO per scope.
Blast radius of a hot or wedged DO is one BRF, not one customer.

Hard rules learned in advance: DOs are not enumerable, so the directory/registry is
load-bearing — it is the only complete inventory of scopes and the input to reconciliation
and migrations. Migrations run lazily per-DO on wake (version check in init against the
Drizzle journal), with a reconciliation sweep waking stragglers before a deadline; schema
version skew across live scopes is a **normal state** code must tolerate for a window.

### 5.3 Data: three tiers, events cross boundaries, queries don't

**Tier 1 — operational truth** (DO-SQLite / D1). Transactional writes, constraints,
idempotency, balances. Anything ledger-like is double-entry here.

**Tier 2 — exact history** (domain events → Pipelines → Iceberg on R2, queried via R2 SQL
behind a tenant-scoping query gateway). Reporting, reconciliation, audit. Fed exclusively
by the event stream — application code never writes to the lake. R2 SQL matured through
H1 2026 (aggregations, CTEs, ~196 functions, JOINs, window functions, dashboard querying;
automatic compaction + snapshot expiration in R2 Data Catalog fixed the small-files
brittleness). Still open beta: re-benchmark against a realistic synthetic (≈50M ledger
events / 500 scopes) before locking in. Fallback (DuckDB or external engine reading the
same Iceberg catalog) changes nothing architecturally — **Iceberg is the contract, the
query engine is replaceable.**

**Tier 3 — telemetry** (Analytics Engine / Datadog). Sampled and approximate by design.
Never touches money, never shown to customers as a count. Ops metrics only.

Standing integrity guarantee: a reconciliation job continuously verifies Tier 2 sums match
Tier 1 balances.

GDPR in an immutable lake: PII tokenized/encrypted per-subject with crypto-shredding for
erasure; pseudonymous keys and transaction facts remain. Bokföringslagen's 7-year retention
maps cleanly: PII erasable, facts retained. This is a kernel convention every event producer
follows, not a per-vertical invention.

### 5.4 Cross-tenant calls

Authorization is enforced by the **data owner**, not trusted from the caller. Cross-scope
and cross-tenant access is capability-mediated RPC into the owning DO, which validates,
executes, audits, meters, and rate-limits at one choke point. Never scatter-gather for
analytics — small-N operational fan-out is fine; dashboards read Tier 2.

This same mechanism, productized, is the beställare–utförare network play (§8.3): a work
order crossing from PropCo's scope into a subcontractor's tenant is a mediated RPC with a
commercial meaning.

### 5.5 No dynamic schema

The DatoCMS/Salesforce metadata-driven-schema question dissolves once the kernel owns no
entities. Modules own their tables and Drizzle migrations (Odoo-addon pattern); tenants get
typed custom fields (JSONB + field-definition registry) and a configurable protocol/checklist
engine. Full EAV costs indexes, query plans, reporting, and type safety to buy flexibility
no current vertical needs.

### 5.6 LLM-friendliness as a design requirement

Narrow, aggressively typed SDK (small API surface = small hallucination surface; invalid
states unrepresentable in TypeScript). Agent-oriented docs shipped as skills / CLAUDE.md
conventions. An MCP server for the platform itself (scaffold a module, inspect a tenant's
schema, dry-run a migration, tail events). Reference verticals as few-shot material.
CI guardrails: lint rules banning raw DB/fetch access; contract tests every module must pass.

### 5.7 Adapters: Cloudflare is the deployment target, not a dependency

The auth-platform adapter pattern, applied kernel-wide: every kernel contract is a pure TypeScript
interface, and every kernel service ships at least two adapters — the Cloudflare-native one
(DO / D1 / R2 / Queues; production) and a **pure SQLite/Node one** (local dev, CI,
self-host). No kernel or engine code imports a Cloudflare API directly; only adapters do.

The subtle case is the Durable Object, because it isn't just storage — it is the
consistency and enforcement domain (§5.2, §5.4). So the adapter boundary sits at the
scope-host contract, `getScope(tenantId, scopeId) → RPC stub`, not at the database driver:
the Cloudflare adapter backs the stub with a DO; the pure adapter backs it with an
in-process actor holding one SQLite file per scope, preserving the same serialized-execution
semantics. Tier 2 follows the same logic — Iceberg is already the contract (§5.3), and the
pure adapter writes the same event stream locally, queried via DuckDB. Queues, cron, and
workflow state get a SQLite-backed job-table adapter.

What this buys: fast deterministic local dev and CI (vibe-coded verticals run contract
tests against real kernel semantics without a Cloudflare account); a §9 escrow story that
is literally true rather than aspirational — single-node, but runnable; and the hedge
against Cloudflare pricing/product/deprecation risk that Iceberg-as-contract alone doesn't
cover. The rule is testable and non-negotiable: **a module's contract tests must pass
unchanged on both adapters, and the pure-SQLite adapter stays green in CI forever.**

## 6. Kernel components and build/buy

Principle: **build contracts and control planes, buy engines.** Build what is the moat and
what nobody sells in the needed shape; adopt substrate everywhere else.

| Component | Call | Notes |
|---|---|---|
| Identity / auth | **Have** | Our auth platform. Extend: end-user identity (boende, styrelse, consumers) as first-class, BankID-heavy. |
| Permissions | **Build (small)** | Role @ node in tenancy tree + capability grants, in the auth platform's org layer. Check-API shaped so OpenFGA could swap in later. Decide model now — near-impossible to retrofit. |
| Nested tenancy + provisioning | **Build** | The crown jewel. Directory/registry, per-scope storage, migration orchestration, reconciliation. Largely exists from the auth platform. |
| Module system | **Build (thin)** | Manifest (migrations, permissions, events, extension points), entitlement flags, attachment contracts. Mostly conventions. |
| Integrations framework | **Build** | Connection store + token refresh, connector interface, webhook ingress (signatures, replay protection), outbox with idempotent retries, per-tenant config + health. Steal Nango's interface design; own it for EU sovereignty. Connectors accrete per vertical need: Fortnox, Visma, BankID, Swish, Peppol, Kivra, fastAPI, EDI (Ahlsell/Rexel/Sonepar). |
| Documents + metadata | **Build** | Our document product's engine promoted to a service: R2 + versioning + Vectorize search + retention policies + tenancy-tree permissions. |
| Events / audit / reporting | **Build spine, buy engines** | Event contract (schema-versioned, tenant-tagged, PII-classified), Pipelines→Iceberg, query gateway. Audit log is a product feature, not just ops. |
| Workflows | **Adopt + conventions** | Cloudflare Workflows for durable execution; kernel adds module-owned definitions, human-approval steps, event emission. **No visual BPMN builder — tarpit.** |
| Jobs & scheduling | **Adopt + conventions** | Queues, cron; per-tenant scheduling conventions. |
| Notifications | **Buy transport, build dispatch** | Resend/SES, Nordic SMS (46elks-class); per-tenant templates, preferences, delivery tracking. |
| Billing & entitlements | **Buy billing, build entitlements** | Stripe; entitlements coupled to module system + orchestrator. |
| GDPR machinery | **Build** | DSAR export, crypto-shredding erasure, retention policies. Nobody sells it in this shape; a genuine selling point in these markets. |
| Import / migration tooling | **Build** | Staging, mapping, validation, dry-run. Every förvaltar-OS sale is a migration out of Vitec/Fast2/the FSM vendor — turn the biggest sales barrier into onboarding. |
| API surface | **Build (cheap early)** | Per-tenant keys, rate limits, signed outbound webhooks. |
| App shell + design system | **Build shell, buy components** | Login/SSO, org/scope switcher, permission-aware nav, settings, members, audit viewer, notifications, connector UI. **Not** a dashboard framework — that's Retool, a whole company. End-user dashboards: chart components over saved gateway queries; resist configurability until a customer pays for it. |
| Localization | **Build day one** | sv/no/da/en. Retrofits are miserable; the FSM vendor ships three languages. |
| Observability per tenant | **Convention** | tenant/scope IDs on every trace and error (Datadog/Sentry/Better Stack exist). |
| Feature flags | **Adopt** | On entitlements, or GrowthBook. |

Sequencing discipline: **kernel work is never more than one step ahead of a vertical that
needs it.** Kernel-first only where retrofit is brutal: tenancy model, permission model,
event schema, module manifest, i18n. Everything else earns its way in when a second
consumer proves the contract (the auth-platform extraction pattern, applied deliberately).
Version every kernel contract (RPC interfaces, event schemas, manifest) with semver from
day one — the moment two verticals depend on it, unversioned changes halt both roadmaps.

## 7. Market landscape

### 7.1 The category gap

Every ingredient exists as a standalone company — WorkOS/Clerk (identity+orgs), Nile
(tenant-virtualized Postgres), Nango/Paragon (integrations), Inngest/Trigger.dev (jobs),
Stripe (billing) — and nobody has bundled the chassis, because the chassis alone has no
buyers; only products built on it do. Hence: **Chassis is an internal architecture
investment justified by owned verticals, with category optionality on top** — the auth-platform
playbook.

### 7.2 Nearest neighbors and why they aren't this

- **Prompt-to-app** (Lovable, Bolt, Replit, Base44, Emergent): generate the dangerous parts
  instead of standing on hardened ones. The 70% problem is their structural ceiling.
- **Templates/boilerplates** (MakerKit, ShipFast, Open SaaS, Bullet Train): closest
  articulation of "LLM-friendly foundation," but guarantees are conventions that erode with
  every edit; no nested tenancy, no provisioning, no engines; $199–649 one-time economics
  ([ShipFast](https://shipfa.st/), [MakerKit](https://makerkit.dev/)).
- **Baseplate.dev** (Half Dome Labs): nearest neighbor by pitch ("AI writes the logic,
  nobody wrote the foundation"). Deterministic codegen, Diff3-preserving regeneration —
  and proudly **ejectable** ("no runtime dependencies"). The exact opposite pole: they
  generate the foundation and leave; we are the foundation and stay. Cleanest contrast for
  positioning.
- **BaaS** (Supabase, Convex): app-shaped, not vertical-SaaS-shaped; Supabase's enforcement
  primitive (RLS) is precisely the vibe-coding foot-gun.
- **Salesforce / ServiceNow**: proof the category works at the top of the market — now with
  AI app generation — but proprietary, US-hosted, enterprise-priced, build-inside-our-world.
  Nobody has built the code-first, developer-owned, EU version.
- **Odoo / Frappe(ERPNext)**: the platform-with-modules thesis executed; you inherit their
  ORM, worldview, and upgrade treadmill. Platform, not kernel.

### 7.3 Unclaimed differentiators

Runtime enforcement instead of conventions · nested B2B tenancy as first-class · hardened
domain engines (nobody ships a work-order engine as a platform module — platform companies
lack the vertical operators to derive them from) · EU data sovereignty (a real purchasing
criterion in our markets; unaddressed by US builders) · operator-anchored proof (others demo
todo apps; we demo a förvaltningsbolag running five offices).

### 7.4 Convergence risks

Lovable/Replit pushing toward production-grade from above; Supabase/Convex adding B2B
primitives from below; Salesforce descending downmarket with AI. Durable ground: enforcement
architecture + compliance machinery + vertical depth is a **trust** moat, not a capability
moat — model improvements don't erode it (same reason auth didn't stop being a product when
LLMs learned OAuth).

### 7.5 Vertical market notes (gathered en route)

- **Swedish FSM / arbetsorder** (the FSM vendor's market): crowded — Hantverksdata Entré, Mowin,
  Minuba, Coredination, Trinax, Fieldly, Next, Bygglet, SmartDok. The FSM vendor's moat is decades of
  vertical depth: OVK-protokoll, F-gas registerföring, borrprotokoll→SGU, EDI grossist
  pricing, ROT-fördelning. Fortnox integration is table stakes.
- **Fastighetssystem**: Vitec and Momentum are the legacy giants, Fast2 acquired by
  Addnode/SWG 2023, **Pigello** is the modern challenger (200+ bolag, covers ekonomi,
  ärenden, boendeportal, and explicitly uppdragsförvaltning). Industry integration standard:
  Sveriges Allmännytta's **fastAPI** (Vitec/Momentum/Fast2 shared IoT integration —
  sensor → felanmälan). Support it day one for cheap credibility.
- Ekonomisk förvaltning (avisering, autogiro, reskontra, inkasso, andelstal) is where the
  incumbents' moat lives — **a boundary, not a v1 module**. Integrate Fortnox/Visma instead.
- **What these markets pay** (2026, sources checked 2026-07-12):
  - FSM per user/mo: [Mowin 370 SEK flat](https://mowin.com/sv/priser) ·
    [Coredination 290–519 SEK](https://www.coredination.com/priser/) ·
    [Fieldly 219–699 SEK + EDI add-on 399 SEK/mo](https://sv.fieldly.com/priser) ·
    [Minuba ~109–269 SEK by role](https://minuba.se/priser/) ·
    [Bygglet per package, 1,049–2,289 SEK/mo](https://bygglet.com/paket-och-priser/).
    A 20-person installation firm lands around **5–10k SEK/mo** — the revenue an FSM
    vertical competes for.
  - Fastighetssystem: [Momentum packages 5,900–25,200 SEK/mo](https://www.momentum.se/prisplan-fastighet/)
    (rare public pricing, sized by apartment count); Pigello and Vitec are quote-only —
    proxy: [~11,580 SEK/mo for ~500 apartments](https://businesswith.se/system/pigello/).
  - Board portals price **per BRF**: [Boardeaser 599–999 SEK/mo, BRFs from ~299 SEK/mo](https://boardeaser.com/priser/brf/)
    — a direct market anchor for per-scope platform pricing (§9).
  - Modular per-engine precedent: [Fortnox sells modules at 89–369 SEK/mo](https://www.fortnox.se/produkt/prislista)
    on top of packages; [Odoo €19.90–29.90/user/mo](https://www.odoo.com/pricing).

### 7.6 Price anchors (what the ingredients cost à la carte, 2026)

What a serious B2B SaaS team pays today for the pieces Chassis bundles — i.e., the
willingness-to-pay evidence for a platform fee:

| Ingredient | Vendor | Price | Source |
|---|---|---|---|
| Auth + orgs (B2B) | Clerk | $25/mo + $0.02/MRU; B2B add-on $100/mo + ~$0.60–1/org/mo | [clerk.com/pricing](https://clerk.com/pricing) |
| Enterprise SSO/SCIM | WorkOS | $125/connection/mo (volume → ~$65) | [workos.com/pricing](https://workos.com/pricing) |
| Auth (B2B plans) | Auth0 | $800/mo per 1,000 MAU, 5-SSO-connection cap | [auth0.com/pricing](https://auth0.com/pricing) |
| BaaS | Supabase | Pro $25/mo; Team (SOC2, SSO) $599/mo + usage | [supabase.com/pricing](https://supabase.com/pricing) |
| Integrations infra | Nango | $50–500/mo + $1/connection/mo | [nango.dev/pricing](https://nango.dev/pricing) |
| Unified integrations API | Merge.dev | $650/mo for 10 linked accounts, then $65/account/mo | [merge.dev/pricing](https://www.merge.dev/pricing) |
| Embedded integrations | Paragon | not public; reported $15k–50k+/yr | [nango.dev/blog](https://nango.dev/blog/paragon-pricing/) |
| Durable jobs/workflows | Inngest | Pro $99/mo per 1M executions | [inngest.com/pricing](https://www.inngest.com/pricing) |
| Internal-tool UI | Retool | ~$10–50/builder + $5–15/internal user/mo; external users tiered | [retool.com/pricing](https://retool.com/pricing) |
| App platform (top of market) | Salesforce Platform | $25–150/user/mo | [salesforce.com](https://www.salesforce.com/platform/enterprise-app-development/pricing/) |
| Prompt-to-app | Lovable / Bolt / Replit | ~$25/mo prosumer + usage credits | [lovable.dev/pricing](https://lovable.dev/pricing) |
| Boilerplate | MakerKit / ShipFast | $199–649 one-time | [makerkit.dev](https://makerkit.dev/) |
| Post-hoc hardening | consultancies | £1.5k–5k fixed per app; ~$6k–32k year-one true cost | [originalobjective.com](https://www.originalobjective.com/software-development/vibe-coding-production-support) |

Read: a vertical team assembling identity + orgs + integrations + jobs + a compliance
story from parts pays roughly **$1–3k/mo before writing a line of domain code** — and still
owns the glue. That bracket is the à-la-carte anchor for kernel pricing. The verticals
themselves price against per-user incumbents (§7.5 numbers).

### 7.7 Who gains most: the niche-vertical cost curve

A production-grade foundation costs roughly the same to build whether the product will
serve 50 seats or 50,000 — tenancy, auth, audit, and GDPR don't get cheaper because the
market is small. Horizontal players amortize that fixed cost over enormous N. A niche
vertical (CRM for one trade, order management for one supply chain, förvaltning for one
region) cannot — which is why niche B2B prices run at multiples of volume tools (visible
in §7.5: package-priced fastighetssystem at 5,900–25,200 SEK/mo against volume FSM at a
few hundred SEK per user), and why the long tail below "fundable SaaS" stays on
spreadsheets, Access databases, and — lately — vibe-coded internal tools.

Chassis collapses the equation twice: AI removes most of the domain-logic cost, and the
kernel converts the foundation from a fixed build into a per-tenant fee. **The relative
gain is therefore largest exactly where the user base is smallest** — enterprise-priced
niche services with high ACV and few seats. Their buyers also demand the most compliance
(procurement checklists, SSO, audit trails, DSAR) — which is the kernel's product, not the
vertical's problem. Consequences:

- **ICP sharpened**: the ideal Chassis vertical is small-N, high-ACV, compliance-touched —
  the segment where foundation cost, not demand, is the binding constraint. Every owned
  vertical (§8) already has this shape.
- **Pricing headroom**: a kernel fee that is a rounding error against niche ACVs is still
  an order of magnitude cheaper than building the foundation once. Price the kernel on
  value per vertical, not cost-plus — and expect it to differ across verticals.
- **Revenue math flips**: small-N verticals yield few scopes, so per-scope fees alone
  under-monetize them; the value-based platform fee and engine licensing carry the load
  there, while per-scope pricing shines in many-scope shapes (förvaltning, chains).

The portfolio statement of the same fact: **no single niche vertical can justify building
the foundation; a portfolio of them can — but only if the foundation is shared.** That is
the chassis business.

## 8. Concrete cases and sequencing

### 8.1 Case 1 — Förvaltar-OS for PropCo (anchor)

PropCo: a long-established regional förvaltningsbolag with several offices, BRF +
commercial, existing internal work orders/hour registration and a self-built board portal. Built as internal
replacement first, productized second. Exercises nearly the whole kernel: two-level tenancy
(PropCo → hundreds of BRF scopes), the full permission tree (staff, fältpersonal, styrelse
per scope, boende per scope), fastighet→byggnad→objekt→komponent asset hierarchy,
ärende→arbetsorder→tid, ronderingar/protokoll, documents, Fortnox, felanmälan portal,
cross-scope reporting, import-from-incumbents tooling.

**The FSM vendor as bridge, not alternative**: PropCo signs the FSM vendor this fall
(shortest term; API tillval and data export as conditions). It becomes production system,
living requirements spec, and migration-tooling test target. Every friction PropCo's team
hits in it is an observed, prioritized backlog item. Acceptance test for switching: **run both systems in parallel for
one full month-end and diff the fakturaunderlag.**

Customer-zero bias to guard: PropCo validates the FSM core, not the regulated
branschmoduler (F-gas, OVK, borr) — those need a design partner from that world later; keep
the core honestly generic.

### 8.2 Case 2 — HouseCo eftermarknad + kundresa (shape-breaker)

Deliberately different shape: lead-centric and project-centric. Lead → offert → kontrakt →
husprojekt (long-running, milestones) → leverans → eftermarknad, where eftermarknad is the
same ärende/arbetsorder engine bound to a delivered house. Customer portal for the byggresa.
Proves the attachment contracts are generic, not secretly förvaltnings-shaped. Starts only
when case 1's ärende engine is extractable — its whole point is reuse.

### 8.3 Case 3 — POSCo adopts kernel services (hardener)

No replatform of a live POS with paying customers. Piecemeal, reversible adoptions that
harden individual contracts: auth → the auth platform (the byrå feature *is* nested tenancy),
Fortnox sync → integrations hub, events → reporting spine. The same hardener role MediaCo played for the auth platform.

### 8.4 Case 4 — FSM-vendor competitor (derived, not built)

Once case 1's arbetsorder/tid/protokoll/schemaläggning engine runs in the field, an
installations-FSM is that engine + new asset vocabulary + vertical protocol packs + EDI.
Find one design-partner kylfirma/ventilationsföretag — plausibly one of PropCo's own
subcontractors.

**The network wedge**: PropCo sits on the beställare side of hundreds of underentreprenörer.
Arbetsorder issued in PropCo's system → received in the subcontractor's own (cheap/free)
instance → time, photos, protokoll flow back → fakturaunderlag lands automatically. Every
förvaltningsuppdrag PropCo wins seeds subcontractor accounts; distribution rides existing
commercial relationships. The FSM vendor sells single-company tools; a beställare–utförare network is a
different category, only available to someone who *is* a large beställare. Technically it is
§5.4 productized.

**If "buy the FSM vendor" means acquiring the company outright** (long-established,
presumably founder-owned, legacy tech, loyal install base): different and potentially better
play — buy decades of vertical knowledge and distribution, re-platform over years. 10x the commitment. Establish which game
is being played before fall.

### 8.5 Sequencing (staggered, never parallel greenfields)

1. Kernel-first: tenancy tree, permission model, event schema, module manifest, i18n —
   built as part of case 1, not before it.
2. Case 1 as the vehicle; FSM-vendor bridge signed; POSCo's auth-platform adoption runs early in
   parallel (existing muscle).
3. Case 2 when the ärende engine extracts. 4. Parallel-run month-end → PropCo migrates.
5. Subcontractor network opens as first external market. 6. Branschmoduler + head-on FSM-vendor
   competition from a position of running product and captive distribution.

Team reality: ~7 people across existing ventures. Three simultaneous greenfields is how
kernels become the reason nothing ships.

## 9. Commercial structure

**Ownership map** (write down before code): kernel — the kernel owner's side. Engines — the
kernel owner's side as licensed modules, friend's teams contribute domain knowledge under
CLA (the AGPL+CLA muscle proven on the auth platform). Verticals — the friend's companies: branschlogik, GTM, customers. If
engines end up on the friend's side, the "platform" is an empty chassis and should be priced
as one — be honest about which product is being sold.

**Fee model — four meters, priced asymmetrically.** Two user populations exist: the
customer's staff, and the customer's customers (boende, styrelse, subcontractors,
consumers). They must not be priced the same way. And the meters weigh differently per
vertical shape (§7.7): many-scope verticals monetize through meters 1 and 4; small-N,
high-ACV niche verticals through a value-based platform fee and engine licensing — don't
flat-rate the kernel across verticals.

1. **Base platform fee** per tenant + per active scope. Precedent: the whole market prices
   orgs (Clerk ~$0.60–1/org/mo at volume, WorkOS $125/connection/mo, §7.6); per-scope is
   the kernel's natural unit and maps to per-BRF/per-filial value — and the end market
   already pays per scope (board portals at ~299–999 SEK/mo per BRF, §7.5).
2. **Per-engine licensing**: entitlement flags are already SKUs — pricing per engine is the
   module system turned commercial. Swedish SMEs accept modular pricing (Fortnox sells per
   module; Odoo per app). Licensed engines carry the small rev-share kicker; full revenue
   share on someone else's vertical means auditing their P&L forever — avoid.
3. **Usage** (Tier-2 events retained, storage GB, API calls): generous included tiers,
   transparent cost-plus overage — WFP makes per-tenant attribution clean. Rule: usage fees
   track cost, never profit — punishing full audit trails punishes the moat.
4. **Network transactions**: a cross-tenant arbetsorder (§5.4, §8.4) is a countable,
   high-value event; per-transaction fee scales with the network rather than seats and is
   structurally unavailable to single-company tools.

Staff seats are the **vertical's** revenue (their GTM, priced against §7.5 incumbents);
the kernel charges the vertical, not the end customer. End-users are never seat-priced —
bundled MAU with overage (the Clerk shape) — or portal and network adoption dies.

**Engines and integrations as a revenue stream** — three forms: (a) design partners fund
engine v1 as paid development, IP stays kernel-side under the CLA (new engines get built
without speculative kernel investment — the one-step-ahead rule holds); (b) the engine then
licenses per-tenant/mo as a module; (c) connectors: table-stakes ones (Fortnox, BankID)
bundled, premium ones (EDI grossist, branschprotokoll packs) priced per connection —
the market already does this (Fieldly retails EDI at 399 SEK/mo, §7.5; Merge's
$65/account/mo and Nango's $1/connection are the infra-side anchors, §7.6).

**N=1 honesty**: with one customer group this is a development partnership wearing a
platform license as a costume. Two acceptable framings: (a) partnership pricing (fees +
services fund buildout; preferential terms + roadmap influence) converting to arm's-length
pricing at the second external consumer; or (b) fold the kernel into the auth platform's natural
expansion (identity → orgs/tenancy → integrations → documents → events) with the friend
group as design partner #2 after MediaCo — the version with a market beyond one friendship.

**Trust structure / exit path** (protects the friendship and enables the bet): AGPL
kernel + commercial license + hosted control plane + support, or source escrow at minimum.
Converts "existential dependency on the kernel owner" into "we pay for the good version of something
we could self-host in a pinch" — made literally true by the pure-SQLite adapters (§5.7),
single-node but runnable — and is the same pitch that sells to strangers later.

**Who builds the verticals** — verify before pricing anything. The friend has salespeople
and operators; vertical teams on Chassis need one or two technically-literate people
wielding AI against a platform designed for it (which matches the team he has), plus the
two human checkpoints (§4). If capacity is thinner: the kernel owner's team builds vertical v1 as
paid work, handover priced explicitly.

**Governance day one**: where the kernel legally lives (own entity or clearly owned
codebase), versioned contracts, because the consumers have different owners. Cheap to decide
now; a negotiation after PropCo runs on it.

## 10. Risks

1. **Platform trap**: kernel features nobody consumes yet = the trap announcing itself.
   Mitigation: the one-step-ahead rule (§6).
2. **N=1 economics**: platform fee from one group won't fund the kernel for years.
   Mitigation: §9 framings; auth-platform convergence.
3. **Convergence** from Lovable-above / Supabase-below / Salesforce-downmarket.
   Mitigation: trust moat (§7.4), EU positioning, vertical depth.
4. **Team spread**: ~7 people, two companies, now three-plus initiatives. Mitigation:
   staggered sequencing (§8.5); PropCo runs on the FSM vendor until the parallel-run test passes.
5. **Customer-zero bias**: PropCo validates FSM core, not regulated branschmoduler.
   Mitigation: design partner from the trades before case 4 ships modules.
6. **Live-product risk (POSCo)**: replatforming a POS breaks it. Mitigation: service
   adoption only, each step reversible.
7. **Cross-ownership friction**: kernel and verticals owned by different people.
   Mitigation: §9 governance, escrow/AGPL, decision log.
8. **R2 SQL beta risk**: mitigated by Iceberg-as-contract; engine swappable.
9. **Cloudflare concentration**: the entire runtime sits on one vendor — pricing, limits,
   deprecations, or Cloudflare moving up-stack. Mitigation: adapter rule (§5.7) — contracts
   are pure interfaces, the pure-SQLite adapter stays green in CI, DO is an adapter not a
   dependency.

## 11. Open questions

- Does "buy the FSM vendor" mean subscribing or acquiring the company outright? (Changes case 4 entirely.)
- Who, concretely, are the friend's builders? Names, hours, stack fluency.
- Kernel legal home: new entity, the auth platform's umbrella, or the existing holding company?
- Permission engine: small built-in model vs embedded OpenFGA — decide before case 1 schema.
- Storage shape for förvaltar-OS confirmed as Shape B? Benchmark DO-SQLite limits first.
- R2 SQL benchmark (≈50M events / 500 scopes) — pass/fail criteria and date.
- Which Nordic SMS + email providers (transport buy list).
- Techy friend: advisor, collaborator, or competitor? Decide what role the RFC recruits for.
- Public brand trademark/domain pass for "Chassis" before launch (Groundplane as fallback).

## 12. Decision log

| # | Date | Decision | Rationale |
|---|---|---|---|
| 1 | 2026-07-12 | Kernel, not platform: no domain entities in core; attachment contracts instead | Avoids Salesforce/EAV problem; keeps verticals flexible (§3, §5.5) |
| 2 | 2026-07-12 | Runtime enforcement over conventions/codegen | The one property templates and Baseplate can't copy; survives model improvement (§4) |
| 3 | 2026-07-12 | Two-level tenancy (tenant → scope), tree-shaped permissions | Recurs in every case; retrofit near-impossible (§5.1) |
| 4 | 2026-07-12 | DO = consistency domain (scope), not tenant | Blast radius + size caps (§5.2) |
| 5 | 2026-07-12 | Three data tiers; events cross boundaries, queries don't; Iceberg as contract | Integrity + engine replaceability (§5.3) |
| 6 | 2026-07-12 | No dynamic/EAV schema; module-owned migrations + typed custom fields | Flexibility no vertical needs vs real costs (§5.5) |
| 7 | 2026-07-12 | Vertical #1 = förvaltar-OS (PropCo), not FSM-vendor replica | Operator depth + customer zero; FSM market crowded with no edge (§8.1) |
| 8 | 2026-07-12 | FSM-vendor subscription as bridge + requirements spec; parallel-run month-end as acceptance test | Don't run a business on a half-built tool (§8.1) |
| 9 | 2026-07-12 | POSCo adopts services piecemeal; no replatform | Live product, paying customers (§8.3) |
| 10 | 2026-07-12 | Ekonomisk förvaltning out of v1; integrate Fortnox/Visma | Incumbent moat; regulated; bank integrations (§7.5) |
| 11 | 2026-07-12 | Build contracts + control planes; buy engines | Team size; moat location (§6) |
| 12 | 2026-07-12 | Name: **Chassis**. Tagline: **The hard parts, hosted.** | Structure+engines+wiring in one word; only dead squatters; Swedish-native pronunciation. Groundplane = fallback |
| 13 | 2026-07-12 | Master doc = canonical; PDFs/decks are dated exports | Single source of truth (§0) |
| 14 | 2026-07-12 | Every kernel contract ships a Cloudflare adapter **and** a pure SQLite adapter; contract tests pass on both | Auth-platform pattern; makes escrow/self-host real, hedges vendor risk, enables local dev/CI (§5.7) |

## 13. Next actions

1. Kernel owner: push this doc; open issues for each open question in §11.
2. Derive the **operator narrative** (2–3 pages, mark/grund/stammar framing, delivered in
   conversation; ends with the four decisions needed: FSM-vendor bridge terms, builders, ownership/
   fee structure, governance/escrow).
3. Derive the **technical RFC** for the techy friend (architecture-first, alternatives
   considered, risks and open questions as questions; deliberately unpolished; ask him to
   break it).
4. Milestone one: the **15-minute demo** — toy vertical scaffolded by Claude Code on the
   kernel; show generation succeed and cross-tenant access **fail** at the boundary.
5. Clarify the FSM-vendor question (subscribe vs acquire) with the friend before fall.