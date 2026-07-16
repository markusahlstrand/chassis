---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/engine-workorder': minor
'@substrat-run/engine-invoicing': minor
'@substrat-run/engine-protocol': minor
---

Zod 4, and `contracts` re-exports `z` — closing a live from-scratch trap

**The trap.** The published packages depend on `zod ^3.25.0` while `pnpm add zod`
— which getting-started told users to run — installs Zod 4. pnpm resolves both:
Zod 3 nested for our packages, Zod 4 for the user. Two copies, both "correct".
Zod schemas do not compose across majors, so the moment a user wrote the pattern
CLAUDE.md mandates ("operation inputs go through Zod schemas at the boundary")
composing a contracts schema into their own —

    z.object({ facility: entityRef, unitPrice: money })

— it failed at RUNTIME with `Invalid element at key "facility": expected a Zod
schema`, an error pointing nowhere near the cause. Not an exotic pattern: it is
what `engines/workorder` itself does (`unitPrice: money`, `facility: entityRef`),
so anyone copying the reference hit it immediately. Found by building a vertical
from scratch against the published packages — the flow the docs describe and
nobody had walked.

**Two fixes, because they solve different halves.**

1. **Zod 4 everywhere.** Aligns with what the ecosystem installs by default, so a
   user who reaches for `zod` gets our major. No code changes were needed — the
   schema subset in use (`z.object`, `.regex`, `.brand`, `.min`, `.optional`,
   `z.infer`) is stable across the major, and the one `z.record` was already the
   2-arg form Zod 4 requires. Build, typecheck, and the full suite pass unchanged.
2. **`contracts` re-exports `z`.** The durable half: importing `z` from
   `@substrat-run/contracts` means the consumer never installs zod at all, so the
   versions cannot diverge. Fix 1 makes the trap dormant; fix 2 keeps it dormant
   when Zod 5 ships.

`zod` is dropped from the getting-started install line; docs and the `substrat`
skill both import `z` from contracts.

**Breaking for consumers on Zod 3** — deliberately taken now, while there are
effectively none, rather than later when there are.

**Still open:** making `zod` a `peerDependency`. Contracts' schemas are part of
its public API — consumers are meant to compose them, so their copy must be ours
— which is textbook peer. As a plain dependency it nests silently instead of
failing at install. Left as a separate call.
