---
"@substrat-run/demo-meridian": patch
---

**The Meridian SPA works for a real single logged-in user, not just the demo cast.**

The pushed worker returned `/api/me` as `{ principal, via, display }` and had no `/api/cast`, but
the SPA centres on `{ key, display, role, country, employeeId }` + a persona switcher — so a
hosted install served an app that couldn't place the user. This closes that data-contract gap
without committing to any auth model:

- A new **`hr/whoami`** operation resolves the caller's role hint (`hr-admin` / `manager` /
  `employee` / `none`, by probing their own grants) and linked employee from the scope itself. No
  permission gate — it reveals only the caller's own role + own employee id — and the kernel still
  enforces the real permission on every operation.
- The worker's **`/api/me`** returns the SPA shape via `hr/whoami`, so a real owner (holding
  `hr-admin`) lands on the admin/setup surface and an employee on their own work — the same shape
  the dev server already serves. **`/api/cast`** returns `[]` (the persona switcher is a dev-only
  affordance).
- The app **hides the persona switcher** when the cast is empty, so a hosted single-user instance
  shows no demo-character dropdown.

Verified on real `workerd`: after provision, `/api/me` as the owner returns
`{ role: "hr-admin", employeeId: null }` and lands the admin surface; an employee (created with a
`principalRef`) resolves to `{ role: "employee", employeeId: … }`; `/api/cast` is `[]`. 21 node
tests pass. Note: this does not change how identity is resolved (still Better Auth CP-less / the dev
header) — the auth-model decision (per-vertical vs. shared OIDC) is deliberately left open.
