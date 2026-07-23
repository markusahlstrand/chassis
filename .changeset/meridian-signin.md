---
"@substrat-run/demo-meridian": patch
---

**Sign-in / sign-up screen for hosted Meridian.** A deployed instance returned 401 from `/api/me`
with no way to authenticate (production has no persona switcher), so users just saw "unauthorized".
The app now shows a **SignIn screen** (email + password, sign-in/sign-up) that posts to Better Auth
(`/api/auth/*` → the tenant's IdentityDO) and reloads on success. The **first sign-in claims the
owner seat** — the installer becomes `hr-admin` and lands on the Admin/setup surface with their real
name. `useAppData` now surfaces `unauthorized` (401) distinctly from errors; dev (persona/dev-header)
is unaffected. Verified on workerd: 401 → sign-up → `/api/me` returns the `hr-admin` shape.
