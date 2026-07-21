import { z } from 'zod';
import type { DomainEvent } from '@substrat-run/contracts';
import type { ConnectorHandler, ConnectorOptions, ScopeHost } from '@substrat-run/kernel';
import { ScriveApi, SCRIVE_TESTBED, type ScriveParty } from './api.js';
import { renderPdf } from './pdf.js';

export { ScriveApi, SCRIVE_TESTBED, SCRIVE_PRODUCTION } from './api.js';
export { ScriveMock } from './mock.js';
export { renderPdf } from './pdf.js';

/**
 * The Scrive connector — the OUTBOUND half of external signing.
 *
 * `engine-protocol` emits `protocol.signatures-requested` when a vertical
 * freezes a document and sends it for signature. This turns that into a Scrive
 * document: create → set file → set parties (BankID) → start.
 *
 * ## This connector is incomplete, and deliberately so
 *
 * The return path does not exist in the kernel yet, and rather than fake it,
 * the two things it needs are **constructor arguments**. A deployment that
 * cannot supply them cannot use this connector — which is the honest state of
 * the platform, expressed in the type system instead of a comment.
 *
 * What is missing, precisely:
 *
 * 1. **Recording the provider's document id** (`onDispatched`). The id belongs
 *    on `protocol_signature_requests.external_ref`, which lives in the SCOPE
 *    database. Host code cannot write there — `ScopeHost.getScope` demands a
 *    `PrincipalId` and a connector is not one (#97). Until it can, at-least-once
 *    delivery means a retried dispatch creates a SECOND Scrive document, because
 *    nothing recorded that the first one exists. That is not a small gap: it is
 *    duplicate legal documents sent to real signatories.
 * 2. **Recording a signature** (`onSigned`). Same wall, same reason.
 *
 * Two further gaps sit behind those and are not represented here at all:
 * connector state has no home, and nothing schedules a poll (there is no cron,
 * queue or alarm anywhere in the deployment).
 */
export interface ScriveConnectorOptions {
  /** `SCRIVE_TESTBED` by default; production needs a paid licence. */
  baseUrl?: string;
  /**
   * Where Scrive should POST status changes.
   *
   * Scrive's callbacks are **unauthenticated** — there is no signature to
   * verify — so this must be a capability URL (an unguessable secret in the
   * path), and a callback must never be trusted as a fact. It is a hint to
   * re-read `documents/{id}/get`. Optional because polling alone is a complete
   * strategy and needs no ingress at all (#96).
   */
  callbackUrl?: (instanceId: string) => string;
  /**
   * Called once the document is live at the provider. **The #97 seam.**
   *
   * Must persist `externalRef` against the signature request, or the next retry
   * duplicates the document. Required, because a connector that silently
   * forgets what it created is worse than one that refuses to run.
   */
  onDispatched: (report: DispatchedDocument) => Promise<void>;
}

export interface DispatchedDocument {
  instanceId: string;
  tenantId: string;
  scopeId: string;
  /** Scrive's document id — belongs on every request row for this instance. */
  externalRef: string;
  /** The request ids this document covers, in the order its parties were set. */
  requestIds: string[];
}

/** The payload half of `protocol.signatures-requested` this connector reads. */
const signaturesRequested = z.object({
  instanceId: z.string().min(1),
  templateKey: z.string().min(1),
  templateVersion: z.number().int(),
  contentHash: z.string().min(1),
  boundHash: z.string().nullable().optional(),
  method: z.string().min(1),
  parties: z.array(
    z.object({
      requestId: z.string().min(1),
      label: z.string().min(1),
      kind: z.enum(['principal', 'external']),
      ref: z.string().nullable(),
      signatureKind: z.enum(['primary', 'counter']),
    }),
  ),
});

/**
 * Build the handler. Register it with `host.registerConnector`.
 *
 * Only reacts to `method: 'scrive'` — a vertical asking for BankID through
 * another provider emits the same event, and this must not answer for it.
 */
export function scriveConnector(options: ScriveConnectorOptions): ConnectorHandler {
  const baseUrl = options.baseUrl ?? SCRIVE_TESTBED;

  return async (ctx, event: DomainEvent) => {
    const payload = signaturesRequested.parse(event.payload);
    if (payload.method !== 'scrive') return; // not ours; delivered, not effected

    const conn = await ctx.connection('scrive');
    const api = new ScriveApi(conn, baseUrl);

    // The artifact. NOT the avtal — this connector cannot read the vertical's
    // content, and should not learn its vocabulary in order to try. It renders
    // an attestation sheet naming what is being signed and the hash it is
    // identified by. A real contract needs the vertical's own rendering plus a
    // document store, and neither exists (see README).
    const pdf = renderPdf({
      title: `${payload.templateKey} v${payload.templateVersion}`,
      lines: [
        `Instans: ${payload.instanceId}`,
        `Innehållshash (SHA-256): ${payload.contentHash}`,
        ...(payload.boundHash ? [`Dokumenthash: ${payload.boundHash}`] : []),
        '',
        'Parter:',
        ...payload.parties.map((p) => `  ${p.label} (${p.signatureKind})`),
        '',
        'Signaturen avser innehållet som identifieras av hashen ovan.',
      ],
    });

    const doc = await api.createDocument();
    await api.setFile(doc.id, `${payload.templateKey}.pdf`, pdf);
    await api.update(doc.id, {
      title: `${payload.templateKey} v${payload.templateVersion}`,
      ...(options.callbackUrl ? { callbackUrl: options.callbackUrl(payload.instanceId) } : {}),
      parties: payload.parties.map(
        (p): ScriveParty => ({
          name: p.label,
          // BankID for external signatories; a principal signing through the
          // provider still authenticates, but the flow does not require the
          // stronger method to be meaningful.
          authenticationMethodToSign: p.kind === 'external' ? 'se_bankid' : 'standard',
          // Scrive auto-adds the API user as the author, and exactly one party
          // must be it. The issuing (primary) party is the sender's side, so it
          // is the author — and it still signs. Verified: an explicit author
          // party in `update` replaces the auto one.
          isAuthor: p.signatureKind === 'primary',
          isSignatory: true,
        }),
      ),
    });
    await api.start(doc.id);

    // Hand the id back to whoever can persist it. If this throws, the delivery
    // fails and retries — which is right: an unrecorded document is exactly the
    // state that causes duplicates, so it must not be treated as success.
    await options.onDispatched({
      instanceId: payload.instanceId,
      tenantId: ctx.tenantId,
      scopeId: ctx.scopeId,
      externalRef: doc.id,
      requestIds: payload.parties.map((p) => p.requestId),
    });
  };
}

/**
 * Register the connector on a host.
 *
 * `maxAttempts` is deliberately higher than the executor default: a provider
 * being briefly unreachable is ordinary, and giving up on a signature request
 * after five tries would be giving up on a contract.
 */
export function registerScriveConnector(
  host: ScopeHost,
  options: ScriveConnectorOptions & { id?: string; retry?: ConnectorOptions },
): void {
  host.registerConnector(
    options.id ?? 'scrive',
    'protocol.signatures-requested',
    scriveConnector(options),
    {
      maxAttempts: 8,
      baseDelayMs: 5_000,
      maxDelayMs: 900_000,
      timeoutMs: 30_000,
      ...options.retry,
    },
  );
}
