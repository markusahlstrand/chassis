---
"@substrat-run/vertical-auth": minor
"@substrat-run/demo-meridian": minor
---

**First-run setup state + invite-only sign-up (Phase 1).** A freshly-provisioned instance
now has an explicit setup state instead of a bare login: the IdentityDO exposes
`needsSetup(scopeId)` (the owner seat is still unclaimed), and Meridian uses it to

- serve a **"Set up your workspace — create the admin account"** screen on first visit
  (`/api/me` returns `{ status: 'needs-setup' }` while unclaimed), instead of a plain
  sign-in that gives no hint the first sign-up becomes the admin; and
- **close open sign-up once the admin has claimed it** — after first-run, a stranger who
  finds the URL can no longer self-register (`/api/auth/sign-up/email` returns 403). The
  window is exactly "owner unclaimed", so it closes the instant the admin is created.

The claim itself is unchanged (trust-on-first-use — first completed setup wins). The
member-invite path (how teammates join after setup) is the Phase 2 follow-up.
