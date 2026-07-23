---
"@substrat-run/demo-meridian": minor
"@substrat-run/dashboard": patch
---

**Meridian is installable from the dashboard marketplace, and usable from an empty install.**

Meridian (the HR vertical) can now be provisioned as an app from the tenant dashboard,
the same embedded-catalog seam Callout uses, and a freshly-installed (empty) instance
is set up from zero through a new in-app Admin surface.

- **Marketplace wiring.** `@substrat-run/demo-meridian` gains a worker-safe `./module`
  export (its domain module + perms only, never the node/better-auth seed), mirroring
  Callout. The dashboard worker bundles `meridianModule` into its `ScopeDO` and adds a
  `meridian` catalog entry — SKU `['meridian', 'protocol']`, owner granted the `hr-admin`
  permission set so the installer can run the app from day one. Meridian is added to the
  frontend marketplace list, vertical metadata, and dev-mock catalog. A new dashboard
  scenario test provisions a real Meridian app and drives `hr/define-leave-type` +
  `hr/create-employee` on the empty scope — the first-run path, proven end to end.

- **First-run onboarding (the Admin section).** An installed instance starts empty (no
  leave types, people or projects). The app gains an hr-admin-only **Admin** section — a
  first-run setup checklist plus screens to define leave types (with SE/ES statutory
  presets, spec §6), add employees, create projects, and generate the per-period
  **payroll export** (the §7 boundary). Every screen carries proper empty/loading/error
  states and accessible form labels; permission is still checked in the kernel on every
  op, so a non-admin reaching these calls is refused (verified: a manager defining a
  leave type gets `403 permission denied: absence:configure`).

GDPR employee erasure (spec §8) remains a deliberate follow-up: crypto-shredding is keyed
off event `piiClass`/`subjectId` at the kernel/lake level, and there is no vertical-callable
erase primitive yet — a table-only version would look structural without being so, so it is
left unbuilt rather than faked.
