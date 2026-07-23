import {
  CloudflareEmailTransport,
  MockEmailTransport,
  type EmailAddress,
  type EmailMessage,
  type EmailTransport,
  type SendEmailBinding,
} from '@substrat-run/adapter-email';

/**
 * The Dashboard's email seam. Email is an ADAPTER (D-18: a notification transport
 * is infra the host consumes), so it is resolved from the environment and used by
 * HOST code — never a module. The invite email is sent in the request path, where
 * the raw address is still in hand: the `invites.sent` event deliberately carries
 * only the hashed identifier, so no outbox executor could recover an address to
 * send to. The plaintext lives in the admin's own `dashboard_members` roster (the
 * team owner legitimately sees whom they invited); the send here uses the address
 * straight off the invite form.
 */

interface EmailEnv {
  /** The Cloudflare Email Service `send_email` binding, when configured. */
  EMAIL?: SendEmailBinding;
  /** The sender address (e.g. `no-reply@send.substrat.net`); the domain must be onboarded. */
  EMAIL_FROM?: string;
}

/**
 * Resolve the transport: Cloudflare Email Service when the `send_email` binding is
 * present (prod), else the in-memory mock (local dev / tests without a sending
 * domain). The mock accepts and drops — a missing binding must not crash an invite.
 */
export function transportFor(env: EmailEnv): EmailTransport {
  return env.EMAIL ? new CloudflareEmailTransport(env.EMAIL) : new MockEmailTransport();
}

/**
 * The platform sender, from config with a sensible default. Defaults to a dedicated
 * sending SUBDOMAIN (`send.substrat.net`), never the apex: `substrat.net`'s MX is
 * live inbound mail (Migadu) and its SPF is `-all`, so sending from a subdomain both
 * avoids displacing real mail and isolates transactional-sending reputation from the
 * corporate domain. Override with `EMAIL_FROM`.
 */
export function senderFor(env: EmailEnv): EmailAddress {
  return { email: env.EMAIL_FROM ?? 'no-reply@send.substrat.net', name: 'Substrat' };
}

/**
 * Build the team-invitation email. Pure — no transport, no env — so it is trivially
 * testable and the same message is produced in dev and prod. The accept link is a
 * capability sent only to the invitee's address; it names the team (so the worker
 * can resolve the scope on accept) and the invitation id (proven by re-hashing the
 * recipient's own email at accept time, so the link alone is not a bearer token).
 */
export function teamInviteEmail(input: {
  to: string;
  from: EmailAddress;
  teamName: string;
  inviterName?: string | null;
  acceptUrl: string;
}): EmailMessage {
  const inviter = input.inviterName?.trim();
  const lead = inviter ? `${inviter} invited you to join` : 'You have been invited to join';
  const subject = `${lead} ${input.teamName} on Substrat`;

  const text = [
    `${lead} ${input.teamName} on Substrat.`,
    '',
    `Accept the invitation: ${input.acceptUrl}`,
    '',
    'If you were not expecting this, you can ignore this email.',
  ].join('\n');

  const html = `<!-- team invite -->
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;color:#1a1a1a">
  <p style="font-size:15px;line-height:1.5;margin:0 0 20px">
    ${escapeHtml(lead)} <strong>${escapeHtml(input.teamName)}</strong> on Substrat.
  </p>
  <p style="margin:0 0 28px">
    <a href="${escapeAttr(input.acceptUrl)}"
       style="display:inline-block;background:#1a1a1a;color:#fff;text-decoration:none;font-size:14px;font-weight:600;padding:11px 20px;border-radius:8px">
      Accept invitation
    </a>
  </p>
  <p style="font-size:12.5px;line-height:1.5;color:#6b6b6b;margin:0">
    Or paste this link into your browser:<br>
    <a href="${escapeAttr(input.acceptUrl)}" style="color:#6b6b6b">${escapeHtml(input.acceptUrl)}</a>
  </p>
  <p style="font-size:12.5px;line-height:1.5;color:#9b9b9b;margin:24px 0 0">
    If you were not expecting this, you can ignore this email.
  </p>
</div>`;

  return { to: input.to, from: input.from, subject, html, text };
}

/** Minimal HTML-text escaping — the team name and URL are the only interpolations. */
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Escape for an attribute value (double-quoted `href`). */
function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;');
}
