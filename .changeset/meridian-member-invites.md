---
"@substrat-run/vertical-auth": minor
"@substrat-run/adapter-cloudflare": minor
"@substrat-run/demo-meridian": minor
---

**Member invites (Phase 2) — the post-setup join path.** Once a workspace is set up it's
invite-only; this adds the flow that lets teammates in:

- **IdentityDO** gains an `invite` directory (token *hash* only) + `createInvite` /
  `listInvites` / `inviteExists` / `revokeInvite` / `claimInvite`. Claiming binds the
  invitee's subject to a pre-minted member principal.
- **`CloudflareScopeHost.assignScopeRole(scopeId, principal, roleKey)`** — the member half
  of `provisionScopeLocal`'s owner grant: grant a principal a role at scope level so its
  permissions resolve from the scope's own storage (covered by two new workerd tests).
- **Meridian**: admin-only `POST/GET /api/invites` (+ `…/revoke`) mint/list invites (role
  granted at creation, one-time accept link returned, plaintext token never stored);
  `POST /api/accept-invite` claims one while signed in; the sign-up gate also opens for a
  valid `?invite=` token. SPA: an admin **Access** tab (invite at a role, copy the link,
  revoke) and an **AcceptInvite** screen driven by `?invite=<token>`.

Roles a teammate can be invited at are this vertical's roles (hr-admin | manager | payroll);
employees (HR records) remain separate.
