---
layout: home

hero:
  name: Substrat
  text: The hard parts, hosted.
  tagline: A runtime-enforced substrate for building vertical B2B SaaS — tenancy, permissions, audit, and GDPR live below your API surface, so code built at AI speed can't break them.
  actions:
    - theme: brand
      text: What is Substrat?
      link: /guide/what-is-substrat
    - theme: alt
      text: Getting started
      link: /guide/getting-started

features:
  - icon: 🛡️
    title: Enforcement, not conventions
    details: Generated code cannot cross a tenant boundary, skip the audit log, or mislabel an event — the guarantees are properties of the substrate, not rules you remember to follow.
  - icon: 🏢
    title: Nested B2B tenancy, first-class
    details: Tenants contain scopes (branches, client companies, brands), each an isolated database with its own permissions. Users hold roles at any node of the tree.
  - icon: ⚙️
    title: Engines you don't have to write
    details: Hardened domain machinery — work orders, invoicing — that owns the invariants (state machines, append-only history, immutable exports) while your vertical owns vocabulary, workflows, and UI.
  - icon: 🤖
    title: Designed for AI-built verticals
    details: A narrow, aggressively typed SDK where invalid states don't typecheck, self-describing module manifests, and contract tests that push back mechanically instead of via prompting.
  - icon: 💾
    title: Runs anywhere the contract runs
    details: Every kernel contract ships a pure-SQLite adapter alongside the production one. Local dev and CI run real kernel semantics — one .sqlite file per scope, no cloud account.
  - icon: 📜
    title: Audit and GDPR built in
    details: Every mutation emits a kernel-stamped event with a mandatory PII classification, keyed for crypto-shredding erasure from day one.
---
