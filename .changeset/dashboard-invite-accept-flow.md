---
"@substrat-run/dashboard": minor
"@substrat-run/oidc-rp": minor
---

Fix the invite → sign-in → accept flow so an invited person lands in the team, not on "create a team".

- **Carry the invite through auth.** An unauthenticated invite click now round-trips through OIDC using the RP's existing `returnTo` (the callback returns to `/invite/<token>`), instead of stashing the token in `localStorage`. The accept always runs with a session in hand, so a first-time invitee joins the team rather than falling through to onboarding.
- **Prefill + sign-up hint.** `@substrat-run/oidc-rp` `beginLogin` / `/api/auth/login` now forward `login_hint` (prefill the invited email) and an allowlisted `screen_hint` (default `signup` for invite links). Both are IdP-standard and backward-compatible for the console.
- **Preview endpoint.** New unauthenticated `GET /api/invites/preview?token=` (backed by a no-permission `dashboard/preview-invite` op — the signed token is the authority, like accept) returns the team name + invited email for the prefill and the accept screen. It reveals only that invite's own address; access still requires the verified-email hash at accept.
- **Graceful mismatch.** Following an invite while signed in as a different verified email now shows a clear "this invite is for X" screen with sign-out, instead of the confusing onboarding dead-end.
