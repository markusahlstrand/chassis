---
"@substrat-run/adapter-email": minor
"@substrat-run/dashboard": minor
---

Send team-invitation emails from the Dashboard via a new notification-transport adapter.

- **`@substrat-run/adapter-email`** — a new host-plane adapter (D-18: a notification transport is infra the host consumes, not a tenant connector). One `EmailTransport` port with swappable implementations: `CloudflareEmailTransport` (the `send_email` Workers binding — default) and `MockEmailTransport` (dev/CI). The port owns the deliverability invariants (both html + text, a subject, a valid recipient) so no implementation can drop them.
- **Dashboard** — `POST /api/members/invite` now emails the invitee their accept link. The send happens in the request path, where the raw address is in hand: the invites engine hashes the identifier and `invites.sent` carries only the hash, so no outbox executor could recover an address to send to. Delivery is best-effort — a committed invite is never rolled back on a send failure (`emailDelivered: false` is reported and the `acceptUrl` is still returned for a manual resend). Adds the `send_email` binding + `EMAIL_FROM` config.
