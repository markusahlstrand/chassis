import {
  type EmailMessage,
  type EmailTransport,
  type PreparedMessage,
  type SendResult,
  EmailError,
  prepareMessage,
} from './transport.js';

export interface MockEmailOptions {
  /**
   * Addresses that hard-bounce — returned in `bounced`, never `delivered`,
   * mirroring Cloudflare's auto-suppression of a hard-bounced address.
   */
  suppress?: Iterable<string>;
  /**
   * Throw on every send with this message — the retryable transport-outage path
   * on demand (a real provider will not fail when you ask it to).
   */
  failWith?: string;
}

/**
 * Email, in memory.
 *
 * A transport cannot be exercised end to end without a provider, and a real
 * sending domain is not always available (and should not send to real people in
 * a test). This records every accepted message so a test can assert an invite
 * went out to the right address with the right link.
 *
 * It proves OUR shape — that a caller built a well-formed message and read the
 * result correctly. It cannot prove Cloudflare accepts that shape or that the
 * mail lands in an inbox; only a real send does that. It stays useful afterward:
 * a real provider will not bounce on demand or let a test inspect the outbox.
 */
export class MockEmailTransport implements EmailTransport {
  /** Every message accepted, in send order — the thing tests assert against. */
  readonly sent: PreparedMessage[] = [];
  private readonly suppressed: Set<string>;
  failWith: string | undefined;

  constructor(options: MockEmailOptions = {}) {
    this.suppressed = new Set([...(options.suppress ?? [])].map((e) => e.toLowerCase()));
    this.failWith = options.failWith;
  }

  /** Suppress an address, as a hard bounce would — later sends to it come back `bounced`. */
  suppress(email: string): void {
    this.suppressed.add(email.toLowerCase());
  }

  /** The most recent accepted message, or undefined — the common one-send assertion. */
  get last(): PreparedMessage | undefined {
    return this.sent[this.sent.length - 1];
  }

  async send(message: EmailMessage): Promise<SendResult> {
    if (this.failWith !== undefined) throw new EmailError(this.failWith);
    // Same validation the real transport runs, so a malformed message fails here
    // in CI rather than silently against the provider.
    const m = prepareMessage(message);
    this.sent.push(m);

    const delivered: string[] = [];
    const bounced: string[] = [];
    for (const a of m.to) {
      (this.suppressed.has(a.email.toLowerCase()) ? bounced : delivered).push(a.email);
    }
    return { delivered, queued: [], bounced };
  }
}
