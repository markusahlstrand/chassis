import { describe, it, expect } from 'vitest';
import { CloudflareEmailTransport, MockEmailTransport, type SendEmailBinding } from '@substrat-run/adapter-email';
import { senderFor, teamInviteEmail, transportFor } from '../src/email.js';

/**
 * The Dashboard email seam: the invite template + transport resolution. The worker
 * HTTP handler is exercised end to end elsewhere; here we pin the message an invitee
 * receives and that the transport falls back to the mock when unconfigured.
 */
describe('teamInviteEmail', () => {
  const acceptUrl = 'https://app.substrat.net/invite/tok.en';

  it('builds a message with both parts, the team, the inviter, and the accept link', () => {
    const msg = teamInviteEmail({
      to: 'jane@acme.com',
      from: { email: 'no-reply@substrat.net', name: 'Substrat' },
      teamName: 'Acme',
      inviterName: 'Markus',
      acceptUrl,
    });

    expect(msg.to).toBe('jane@acme.com');
    expect(msg.subject).toBe('Markus invited you to join Acme on Substrat');
    expect(msg.text).toContain(acceptUrl);
    expect(msg.html).toContain(acceptUrl);
    expect(msg.html).toContain('Acme');
    expect(msg.text.length).toBeGreaterThan(0);
    expect(msg.html).toContain('<a'); // a real link, not just text
  });

  it('falls back to a generic lead when the inviter has no name', () => {
    const msg = teamInviteEmail({ to: 'x@y.com', from: { email: 'no-reply@substrat.net' }, teamName: 'Acme', acceptUrl });
    expect(msg.subject).toBe('You have been invited to join Acme on Substrat');
  });

  it('escapes the team name in the html (no raw markup injection)', () => {
    const msg = teamInviteEmail({
      to: 'x@y.com',
      from: { email: 'no-reply@substrat.net' },
      teamName: '<script>Acme</script>',
      acceptUrl,
    });
    expect(msg.html).not.toContain('<script>Acme</script>');
    expect(msg.html).toContain('&lt;script&gt;Acme&lt;/script&gt;');
  });

  it('produces a message the mock transport accepts and reports delivered', async () => {
    const mail = new MockEmailTransport();
    const result = await mail.send(
      teamInviteEmail({ to: 'jane@acme.com', from: senderFor({}), teamName: 'Acme', inviterName: 'M', acceptUrl }),
    );
    expect(result.delivered).toEqual(['jane@acme.com']);
    expect(mail.last?.subject).toContain('Acme');
  });
});

describe('transportFor + senderFor', () => {
  it('falls back to the in-memory mock when no send_email binding is present', () => {
    expect(transportFor({})).toBeInstanceOf(MockEmailTransport);
  });

  it('uses Cloudflare Email Service when the binding is present', async () => {
    const sent: unknown[] = [];
    const EMAIL: SendEmailBinding = {
      send(m) {
        sent.push(m);
        return Promise.resolve({ delivered: ['jane@acme.com'], queued: [], permanent_bounces: [] });
      },
    };
    const transport = transportFor({ EMAIL });
    expect(transport).toBeInstanceOf(CloudflareEmailTransport);

    const result = await transport.send(
      teamInviteEmail({ to: 'jane@acme.com', from: senderFor({ EMAIL }), teamName: 'Acme', acceptUrl: 'https://x/invite/t' }),
    );
    expect(result.delivered).toEqual(['jane@acme.com']);
    expect(sent).toHaveLength(1);
  });

  it('defaults the sender to the sending subdomain and honours an override', () => {
    expect(senderFor({})).toEqual({ email: 'no-reply@send.substrat.net', name: 'Substrat' });
    expect(senderFor({ EMAIL_FROM: 'hello@acme.com' })).toEqual({ email: 'hello@acme.com', name: 'Substrat' });
  });
});
