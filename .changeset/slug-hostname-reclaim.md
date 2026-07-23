---
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/dashboard': minor
---

**Deleting an app reclaims its slug + hostname.** A failed or deleted app used to strand
its scope slug and hostname forever — no way to reuse the name.

- **A deleted app is now ARCHIVED, not suspended** (`deprovisionApp`): archive is the
  terminal delete state — offline (`getScope` fails closed), record retained (audit), and
  it *releases* the name (suspend is reversible, so it keeps it).
- **`archiveScope` is allowed from `provisioning`** (both adapters), so a scope whose
  provisioning never completed (a failed create) can be abandoned instead of stranding
  its name.
- **Slug + hostname uniqueness ignore `archived` scopes** — the scope-slug check excludes
  archived scopes, and `bindHostname` reclaims a hostname whose holder is archived. So
  delete → recreate with the same name works, at the same `<name>.<jur>.substrat.run`.

Verified: adapter suites (146) + dashboard suites (11) pass, including a new assertion
that after deleting an app, a new one takes the same slug *and* the same clean hostname.
