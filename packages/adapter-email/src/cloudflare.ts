import {
  type EmailAddress,
  type EmailMessage,
  type EmailTransport,
  type SendResult,
  prepareMessage,
} from './transport.js';

/**
 * The Cloudflare Email Service `send_email` Workers binding, typed
 * structurally so this package pulls in no platform typings (the kernel/scrive
 * convention — a locally-declared shape the real
 * `@cloudflare/workers-types` binding is assignable to).
 *
 * Bound in `wrangler.jsonc` as `"send_email": [{ "name": "EMAIL" }]`. No API
 * key: the binding IS the credential, and the `from` domain must be onboarded
 * (`wrangler email sending enable substrat.run`), which also auto-configures
 * SPF/DKIM because the zone is already on Cloudflare.
 */
export interface SendEmailBinding {
  send(message: {
    to: BindingAddress | BindingAddress[];
    from: { email: string; name?: string };
    replyTo?: BindingAddress;
    subject: string;
    html?: string;
    text?: string;
    headers?: Record<string, string>;
  }): Promise<CloudflareSendResponse>;
}

type BindingAddress = string | { email: string; name?: string };

/** CF returns immediate per-recipient feedback; the REST surface wraps it in `result`. */
interface CloudflareSendBody {
  delivered?: string[];
  permanent_bounces?: string[];
  queued?: string[];
}
type CloudflareSendResponse = CloudflareSendBody | { result: CloudflareSendBody };

/**
 * Send platform transactional mail through Cloudflare Email Service — the
 * default transport for invites, resets, and receipts on substrat.run. Same
 * platform, no new sub-processor (Cloudflare is already the foundational one),
 * and managed IP reputation + suppression lists + soft-bounce retries handled
 * by the service.
 *
 * The only thing a spec sheet can't promise is inbox-placement at volume; this
 * being a swappable port is the hedge — a warmer provider (Resend) is another
 * implementation of the same interface, not a rewrite. See README.
 */
export class CloudflareEmailTransport implements EmailTransport {
  constructor(private readonly binding: SendEmailBinding) {}

  async send(message: EmailMessage): Promise<SendResult> {
    const m = prepareMessage(message);
    const response = await this.binding.send({
      to: m.to.map(toBinding),
      from: toBinding(m.from),
      ...(m.replyTo ? { replyTo: toBinding(m.replyTo) } : {}),
      subject: m.subject,
      html: m.html,
      text: m.text,
      ...(m.headers ? { headers: m.headers } : {}),
    });
    // The Workers binding returns the body directly; the REST surface wraps it
    // in `result` — accept either so the same transport works over both.
    const body = 'result' in response ? response.result : response;
    return {
      delivered: body.delivered ?? [],
      queued: body.queued ?? [],
      bounced: body.permanent_bounces ?? [],
    };
  }
}

/** Our normalized address → the binding's address shape (identical today; explicit for clarity). */
function toBinding(address: EmailAddress): { email: string; name?: string } {
  return address.name ? { email: address.email, name: address.name } : { email: address.email };
}
