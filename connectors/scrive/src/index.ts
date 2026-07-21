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
}

/**
 * What the connector remembers about a dispatch, stored per-connection in the
 * directory (`ctx.admin.putConnectorState`). Its whole job is idempotency: a
 * redelivery finds this and skips instead of creating a second document.
 */
export interface ScriveDispatchState {
  documentId: string;
  instanceId: string;
  requestIds: string[];
  scopeId: string;
  tenantId: string;
  dispatchedAt: string;
}

/** The connector-state key for one signature request set. */
const dispatchKey = (instanceId: string): string => `scrive:dispatch:${instanceId}`;

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

    // Idempotency (#101 gap 3). Delivery is at-least-once, so a redelivery must
    // not create a SECOND Scrive document — duplicate legal paperwork sent to
    // real signatories. The connector cannot record "done" in the scope, because
    // it runs INSIDE the scope's dispatch and re-entering the scope actor
    // deadlocks (verified). So the dispatch ledger lives in the directory, which
    // `ctx.admin` reaches without touching the scope.
    const key = dispatchKey(payload.instanceId);
    const prior = (await ctx.admin.getConnectorState(conn.id, key)) as
      | ScriveDispatchState
      | undefined;
    if (prior) return; // already dispatched — do nothing, idempotently

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
      // Tag the document with the instance id (verified settable). It is not yet
      // used for dedup — the list-by-tag filter needs a query syntax not settled
      // here — but it makes the eventual provider-side reconciliation that would
      // close the narrow create-then-record window (below) a filter away.
      tags: [{ name: 'substrat_instance', value: payload.instanceId }],
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

    // Record the dispatch so a redelivery skips it. This is the write that
    // closes the duplicate hole for the common case (a retry after a fully
    // successful dispatch).
    //
    // The residual: if this write itself fails after `start` succeeded, the
    // retry finds no state and creates a second document. Closing that fully
    // needs provider-side dedup — the `substrat_instance` tag set above, once a
    // list-by-tag query lets the connector adopt an existing document instead of
    // creating one. Left as a follow-up; a rare double is a large improvement on
    // every-retry-doubles.
    const state: ScriveDispatchState = {
      documentId: doc.id,
      instanceId: payload.instanceId,
      requestIds: payload.parties.map((p) => p.requestId),
      scopeId: ctx.scopeId,
      tenantId: ctx.tenantId,
      dispatchedAt: event.occurredAt,
    };
    await ctx.admin.putConnectorState(conn.id, key, state);
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
