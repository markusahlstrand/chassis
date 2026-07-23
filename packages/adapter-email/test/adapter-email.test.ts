import { describe, expect, it } from 'vitest';
import {
  CloudflareEmailTransport,
  EmailError,
  MockEmailTransport,
  type EmailMessage,
  type SendEmailBinding,
} from '../src/index.js';

const invite = (over: Partial<EmailMessage> = {}): EmailMessage => ({
  to: 'invitee@example.com',
  from: { email: 'no-reply@substrat.run', name: 'Substrat' },
  subject: 'You have been invited to Acme',
  html: '<p>Join Acme: <a href="https://substrat.run/accept/abc">accept</a></p>',
  text: 'Join Acme: https://substrat.run/accept/abc',
  ...over,
});

describe('the transport port', () => {
  it('records a well-formed message and reports it delivered', async () => {
    const mail = new MockEmailTransport();
    const result = await mail.send(invite());

    expect(result).toEqual({ delivered: ['invitee@example.com'], queued: [], bounced: [] });
    expect(mail.sent).toHaveLength(1);
    expect(mail.last?.subject).toBe('You have been invited to Acme');
    expect(mail.last?.to).toEqual([{ email: 'invitee@example.com' }]);
    expect(mail.last?.from).toEqual({ email: 'no-reply@substrat.run', name: 'Substrat' });
  });

  it('enforces both an html and a text part (a deliverability invariant)', async () => {
    const mail = new MockEmailTransport();
    await expect(mail.send(invite({ text: '' }))).rejects.toThrow(EmailError);
    await expect(mail.send(invite({ html: '   ' }))).rejects.toThrow(/no html body/);
    expect(mail.sent).toHaveLength(0); // nothing recorded when it never validated
  });

  it('rejects an empty subject, no recipient, and a non-address', async () => {
    const mail = new MockEmailTransport();
    await expect(mail.send(invite({ subject: '  ' }))).rejects.toThrow(/no subject/);
    await expect(mail.send(invite({ to: [] }))).rejects.toThrow(/no recipient/);
    await expect(mail.send(invite({ to: 'not-an-email' }))).rejects.toThrow(/invalid email/);
  });

  it('coerces a bare string and an array of recipients', async () => {
    const mail = new MockEmailTransport();
    await mail.send(invite({ to: ['a@example.com', { email: 'b@example.com', name: 'B' }] }));
    expect(mail.last?.to).toEqual([{ email: 'a@example.com' }, { email: 'b@example.com', name: 'B' }]);
  });
});

describe('MockEmailTransport failure paths', () => {
  it('returns a suppressed address as bounced, never delivered', async () => {
    const mail = new MockEmailTransport({ suppress: ['Bounced@Example.com'] });
    const result = await mail.send(invite({ to: ['ok@example.com', 'bounced@example.com'] }));
    expect(result.delivered).toEqual(['ok@example.com']);
    expect(result.bounced).toEqual(['bounced@example.com']); // case-insensitive match
  });

  it('throws on a simulated transport outage', async () => {
    const mail = new MockEmailTransport({ failWith: 'upstream 503' });
    await expect(mail.send(invite())).rejects.toThrow(/upstream 503/);
  });
});

describe('CloudflareEmailTransport', () => {
  /** A fake `send_email` binding capturing the last call and returning a canned body. */
  function fakeBinding(response: unknown): SendEmailBinding & { calls: unknown[] } {
    const calls: unknown[] = [];
    return {
      calls,
      send(message) {
        calls.push(message);
        return Promise.resolve(response as never);
      },
    };
  }

  it('normalizes the message onto the binding and maps the response', async () => {
    const binding = fakeBinding({ delivered: ['invitee@example.com'], queued: [], permanent_bounces: [] });
    const mail = new CloudflareEmailTransport(binding);

    const result = await mail.send(invite({ replyTo: 'support@substrat.run' }));

    expect(result).toEqual({ delivered: ['invitee@example.com'], queued: [], bounced: [] });
    expect(binding.calls[0]).toMatchObject({
      to: [{ email: 'invitee@example.com' }],
      from: { email: 'no-reply@substrat.run', name: 'Substrat' },
      replyTo: { email: 'support@substrat.run' },
      subject: 'You have been invited to Acme',
    });
  });

  it('accepts a REST-style response wrapped in `result` and maps permanent_bounces', async () => {
    const binding = fakeBinding({ result: { delivered: [], queued: ['slow@example.com'], permanent_bounces: ['bad@example.com'] } });
    const mail = new CloudflareEmailTransport(binding);

    const result = await mail.send(invite());
    expect(result).toEqual({ delivered: [], queued: ['slow@example.com'], bounced: ['bad@example.com'] });
  });

  it('validates before ever calling the binding', async () => {
    const binding = fakeBinding({ delivered: [] });
    const mail = new CloudflareEmailTransport(binding);
    await expect(mail.send(invite({ text: '' }))).rejects.toThrow(EmailError);
    expect(binding.calls).toHaveLength(0);
  });
});
