import { z } from 'zod';
import type { ConnectorConnection } from '@substrat-run/kernel';

/**
 * A thin, typed client over the documented Scrive eSign v2 endpoints.
 *
 * Every call goes through the connection's `fetch`, never a global one: that is
 * what gets it a timeout, an egress policy, and health recorded against the
 * right connection. Module code cannot reach any of this — boundary-lint bans
 * `fetch` outright — and a connector is host code.
 *
 * **Written against the published docs, not against a live account.** Until
 * someone runs it at `api-testbed.scrive.com`, the response shapes below are a
 * reading of documentation. Treat a green test suite as "ready to check", never
 * as "verified".
 */

export const SCRIVE_TESTBED = 'https://api-testbed.scrive.com';
export const SCRIVE_PRODUCTION = 'https://scrive.com';

/** The subset of the document object this connector actually depends on. */
export const scriveDocument = z.object({
  id: z.string().min(1),
  status: z.enum(['preparation', 'pending', 'closed', 'canceled', 'timedout', 'rejected']),
  parties: z
    .array(
      z.object({
        id: z.string().min(1),
        /** Set once that party has signed. */
        sign_time: z.string().nullable().optional(),
        /** Provider-side identifiers; what lands in `evidence_ref`. */
        fields: z.array(z.object({ type: z.string(), value: z.unknown() })).optional(),
      }),
    )
    .default([]),
});
export type ScriveDocument = z.infer<typeof scriveDocument>;

export interface ScriveParty {
  /** Display name for the signing page. */
  name: string;
  email?: string;
  /**
   * Swedish personnummer, when the flow authenticates to sign with BankID.
   *
   * Passed THROUGH to the provider and never persisted by us: it is `direct`
   * PII, and `engine-protocol` deliberately stores an opaque `DataSubjectId` as
   * the signatory instead. The provider needs it; our tables must not have it.
   */
  personalNumber?: string;
  /** `se_bankid` for Swedish BankID; the provider's own vocabulary. */
  authenticationMethodToSign: 'standard' | 'se_bankid';
}

const asJson = async (res: { ok: boolean; status: number; text(): Promise<string> }, what: string) => {
  const body = await res.text();
  if (!res.ok) throw new Error(`scrive ${what} failed: HTTP ${res.status} ${body.slice(0, 400)}`);
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new Error(`scrive ${what}: response was not JSON (${body.slice(0, 200)})`);
  }
};

export class ScriveApi {
  constructor(
    private readonly conn: ConnectorConnection,
    private readonly baseUrl: string = SCRIVE_TESTBED,
  ) {}

  /**
   * OAuth2 bearer. Scrive also documents a PLAINTEXT OAuth1-style header for
   * personal tokens; this uses the bearer form because it is the one with a
   * refresh story, and refresh is what the connection store exists to carry.
   */
  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const token = this.conn.secret.accessToken;
    if (!token) {
      throw new Error(
        `connection ${this.conn.id} carries no accessToken — the secret shape a Scrive ` +
          `connection needs is { accessToken, refreshToken? }`,
      );
    }
    return { Authorization: `Bearer ${token}`, ...extra };
  }

  async createDocument(): Promise<ScriveDocument> {
    const res = await this.conn.fetch(`${this.baseUrl}/api/v2/documents/new`, {
      method: 'POST',
      headers: this.headers(),
    });
    return scriveDocument.parse(await asJson(res, 'documents/new'));
  }

  /**
   * Attach the file. Separate from creation in Scrive's own API, which is what
   * makes a no-file creation step possible at all.
   */
  async setFile(documentId: string, filename: string, pdf: Uint8Array): Promise<void> {
    const res = await this.conn.fetch(
      `${this.baseUrl}/api/v2/documents/${documentId}/setfile`,
      {
        method: 'POST',
        headers: this.headers({ 'content-type': 'application/pdf', 'x-filename': filename }),
        body: base64(pdf),
      },
    );
    await asJson(res, 'setfile');
  }

  /** Parties, callback URL and title, in one update — the documented shape. */
  async update(
    documentId: string,
    patch: { title?: string; parties?: ScriveParty[]; callbackUrl?: string },
  ): Promise<ScriveDocument> {
    const body = {
      document: {
        ...(patch.title ? { title: patch.title } : {}),
        ...(patch.callbackUrl ? { api_callback_url: patch.callbackUrl } : {}),
        ...(patch.parties
          ? {
              parties: patch.parties.map((p) => ({
                authentication_method_to_sign: p.authenticationMethodToSign,
                fields: [
                  { type: 'name', order: 1, value: p.name },
                  ...(p.email ? [{ type: 'email', value: p.email }] : []),
                  ...(p.personalNumber
                    ? [{ type: 'personal_number', value: p.personalNumber }]
                    : []),
                ],
              })),
            }
          : {}),
      },
    };
    const res = await this.conn.fetch(`${this.baseUrl}/api/v2/documents/${documentId}/update`, {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify(body),
    });
    return scriveDocument.parse(await asJson(res, 'update'));
  }

  /** Send it. After this the document is `pending` and the parties are invited. */
  async start(documentId: string): Promise<ScriveDocument> {
    const res = await this.conn.fetch(`${this.baseUrl}/api/v2/documents/${documentId}/start`, {
      method: 'POST',
      headers: this.headers(),
    });
    return scriveDocument.parse(await asJson(res, 'start'));
  }

  /**
   * Current state. This is the POLLING path, and it is why webhook ingress
   * (#96) is not on the critical path: Scrive's callbacks are unauthenticated
   * anyway, so a callback can only ever be a hint to re-read this.
   */
  async get(documentId: string): Promise<ScriveDocument> {
    const res = await this.conn.fetch(`${this.baseUrl}/api/v2/documents/${documentId}/get`, {
      method: 'GET',
      headers: this.headers(),
    });
    return scriveDocument.parse(await asJson(res, 'get'));
  }
}

/** Base64 without node:buffer — web-standard only, so it runs in Workers. */
function base64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return (globalThis as unknown as { btoa(v: string): string }).btoa(s);
}
