---
"@substrat-run/dashboard": minor
---

Add a **Resend** action for pending team invites.

- **Module** — new `dashboard/resend-invite` in-scope operation. It re-mails an outstanding invitation using the address kept in the readable roster (the invites engine stores only a hash), re-checks `manage-members` **and** the §5.1 role bound, and re-composes the engine's `sendInvite` — idempotent for a still-open invitation (same id) and a fresh one if it lapsed — re-pointing the projection at the live invitation. Returns `null` when there is no such pending invite.
- **Worker** — new `POST /api/members/resend-invite`. The initial invite and the resend now share one `mailInvite` helper that mints a fresh accept link and sends the message best-effort. That helper counts a recipient as delivered when Cloudflare Email Service returns it in either `delivered` **or** `queued` (the service is asynchronous, so a successful send is `queued`, not `delivered`).
- **Dashboard UI** — a Resend button beside Revoke on invited rows, with success/failure toasts (a failed send points the admin to the shareable link).
