import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  connectionId,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  type PermissionKey,
} from '@substrat-run/contracts';
import { ulid, webCryptoSecretBox, type ScopeStub } from '@substrat-run/kernel';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { PROTOCOL_PERM as PERM, protocolModule } from '@substrat-run/engine-protocol';
import { ScriveMock, registerScriveConnector, type DispatchedDocument } from '../src/index.js';

/**
 * The outbound half, end to end: a vertical freezes a document and asks for
 * signatures, and a Scrive document appears at the provider with the right
 * parties and a file attached.
 *
 * Everything here runs against `ScriveMock`, so what is proven is that OUR
 * shape works — credential resolution, egress, the document lifecycle, retry.
 * It is not evidence that our reading of Scrive's API is correct; the mock is
 * the same reading. That check needs a testbed account.
 */
describe('scrive connector — outbound dispatch', () => {
  let dir: string;
  let host: SqliteScopeHost;
  let scrive: ScriveMock;
  let dispatched: DispatchedDocument[];
  let staff = platformActorId.parse(ulid());
  let t = tenantId.parse(ulid());
  let s = scopeId.parse(ulid());
  let stub: ScopeStub;

  const EMPLOYEE = { entityType: 'employee', entityId: '01JEMPLOYEE0000000000000AA' };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-scrive-'));
    scrive = new ScriveMock();
    dispatched = [];
    staff = platformActorId.parse(ulid());
    t = tenantId.parse(ulid());
    s = scopeId.parse(ulid());

    host = new SqliteScopeHost({
      dir,
      secretBox: webCryptoSecretBox('k', new Uint8Array(32).fill(5)),
      fetch: scrive.fetch,
    });
    host.registerModule(protocolModule);
    // Stands in for the vertical: declares the entity edge and nothing else.
    host.registerModule({
      manifest: {
        id: '@test/hr',
        version: '1.0.0',
        kernelContract: '^0.0.1',
        permissions: [],
        events: { emits: [], consumes: [] },
        migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
        attachmentTargets: [],
        entityRelations: [{ entityType: 'protocol', parentType: 'employee' }],
        entitlementKey: 'hr',
      } as never,
    });

    registerScriveConnector(host, {
      baseUrl: 'https://api-testbed.scrive.test',
      callbackUrl: (instanceId) => `https://vertical.test/hooks/scrive/${instanceId}-secret`,
      // THE #97 SEAM, supplied by the test because the kernel cannot supply it.
      // Nothing in a real deployment can write this back into the scope yet.
      onDispatched: async (report) => {
        dispatched.push(report);
      },
      // Retry immediately, so a test can watch a failure recover rather than
      // asserting that a timer it cannot advance would eventually fire.
      retry: { baseDelayMs: 0 },
    });

    const principal = principalId.parse(ulid());
    await host.admin.createTenant(staff, { id: t, slug: 'nordljus', name: 'Nordljus' });
    for (const key of ['protocol', 'hr']) await host.admin.grantEntitlement(staff, t, key);
    await host.provisionScope(staff, {
      tenantId: t,
      scopeId: s,
      jurisdiction: 'eu',
      vertical: 'meridian',
    });
    await host.admin.activateScope(staff, t, s);
    await host.admin.defineRole(staff, t, {
      key: 'hr',
      permissions: [
        PERM.create,
        PERM.bind,
        PERM.requestSignature,
        PERM.read,
      ] as PermissionKey[],
      source: 'vertical',
    });
    await host.admin.assignRole(staff, {
      principalId: principal,
      roleKey: 'hr',
      node: { tenantId: t, scopeId: s },
    });
    await host.admin.createConnection(staff, {
      id: connectionId.parse(ulid()),
      tenantId: t,
      vertical: 'meridian',
      provider: 'scrive',
      label: 'Nordljus Scrive (testbed)',
      secret: { accessToken: 'testbed-token' },
    });

    stub = await host.getScope(principal, t, s);
    await stub.invoke('protocol/define-template', {
      key: 'anstallningsavtal',
      title: 'Anställningsavtal',
      content: {
        kind: 'document',
        documentType: 'anstallningsavtal',
        hashRecipe: 'sha256 over the terms row, fields in fixed order',
      },
    });
  });

  afterEach(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Instantiate → bind → request signatures for two parties of different kinds. */
  const issue = async () => {
    const inst = await stub.invoke<{ id: string }>('protocol/instantiate', {
      templateKey: 'anstallningsavtal',
      entityType: EMPLOYEE.entityType,
      entityId: EMPLOYEE.entityId,
    });
    await stub.invoke('protocol/bind-document', {
      instanceId: inst.id,
      contentRef: { entityType: 'employment-terms', entityId: '01JTERMS000000000000000000' },
      contentHash: 'ab'.repeat(32),
    });
    return stub.invoke<{ instance: { id: string }; requests: { id: string }[] }>(
      'protocol/request-signatures',
      {
        instanceId: inst.id,
        method: 'scrive',
        parties: [
          { label: 'Arbetsgivare', kind: 'principal', signatureKind: 'primary' },
          { label: 'Anställd', kind: 'external' },
        ],
      },
    );
  };

  it('turns a signature request into a started Scrive document', async () => {
    const sent = await issue();

    expect(scrive.documents.size).toBe(1);
    const [doc] = [...scrive.documents.values()];
    // Started means Scrive has invited the parties — the file and parties were
    // both accepted, which is what `start` refuses without.
    expect(doc!.status).toBe('pending');
    expect(doc!.file?.name).toBe('anstallningsavtal.pdf');
    expect(doc!.file!.bytes).toBeGreaterThan(0);
    expect(doc!.title).toContain('anstallningsavtal');

    // The external signatory authenticates with BankID; the employer does not
    // need the stronger method for the signature to mean something.
    expect(doc!.parties.map((p) => [p.name, p.auth])).toEqual([
      ['Arbetsgivare', 'standard'],
      ['Anställd', 'se_bankid'],
    ]);

    // A capability URL, because Scrive's callbacks carry no signature to verify.
    expect(doc!.callbackUrl).toContain(sent.instance.id);

    // And the id came back to the seam that will one day persist it.
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]!.externalRef).toBe(doc!.id);
    expect(dispatched[0]!.requestIds).toEqual(sent.requests.map((r) => r.id));
  });

  it('does not answer for a provider that is not Scrive', async () => {
    // The same event carries `method`. A vertical asking for BankID through
    // someone else must not get a Scrive document.
    const inst = await stub.invoke<{ id: string }>('protocol/instantiate', {
      templateKey: 'anstallningsavtal',
      entityType: 'employee',
      entityId: '01JEMPLOYEE0000000000000BB',
    });
    await stub.invoke('protocol/bind-document', {
      instanceId: inst.id,
      contentRef: { entityType: 'employment-terms', entityId: '01JTERMS000000000000000001' },
      contentHash: 'cd'.repeat(32),
    });
    await stub.invoke('protocol/request-signatures', {
      instanceId: inst.id,
      method: 'assently',
      parties: [{ label: 'Anställd', kind: 'external' }],
    });
    expect(scrive.documents.size).toBe(0);
    expect(dispatched).toEqual([]);
  });

  it('records provider failure on the connection and retries rather than losing the request', async () => {
    scrive.failWith = 503;
    await issue();

    // The operation succeeded — the freeze is committed and the request rows
    // exist. Only the delivery failed, and that is not the caller's problem.
    const detail = await stub.invoke<{ instance: { status: string } }>('protocol/get', {
      instanceId: (await stub.invoke<{ instance: { id: string } }[]>('protocol/list-for-entity', {
        entityType: EMPLOYEE.entityType,
        entityId: EMPLOYEE.entityId,
      }))[0]!.instance.id,
    });
    expect(detail.instance.status).toBe('pending_signature');
    expect(dispatched).toEqual([]);

    // Health landed on the connection…
    const [conn] = await host.admin.listConnections(staff, { tenantId: t });
    expect(conn!.status).toBe('error');
    expect(conn!.lastError).toContain('503');

    // …and the delivery is retrying, not dead: 8 attempts is deliberate, since
    // giving up after five would mean giving up on a contract.
    expect(await host.executorDeadLetters(t, s)).toEqual([]);

    // The provider recovers. The next drain completes the dispatch — the point
    // of retrying at all, and the thing a green "it failed" test never shows.
    scrive.failWith = undefined;
    const report = await host.drainDue(t, s);
    expect(report.delivered).toBe(1);
    expect(scrive.documents.size).toBe(1);
    expect(dispatched).toHaveLength(1);

    // Health recovered with it.
    const [healed] = await host.admin.listConnections(staff, { tenantId: t });
    expect(healed!.status).toBe('active');
    expect(healed!.lastError).toBeNull();
  });

  it('refuses to dispatch when the tenant has no Scrive connection', async () => {
    const [conn] = await host.admin.listConnections(staff, { tenantId: t });
    await host.admin.revokeConnection(staff, conn!.id);
    await issue();

    // Nothing was sent, and nothing was recorded as sent — the two together are
    // what distinguish a refused dispatch from a silent no-op.
    expect(scrive.documents.size).toBe(0);
    expect(dispatched).toEqual([]);

    // The freeze still committed: the operation is not the delivery.
    const [summary] = await stub.invoke<{ instance: { status: string } }[]>(
      'protocol/list-for-entity',
      { entityType: EMPLOYEE.entityType, entityId: EMPLOYEE.entityId },
    );
    expect(summary!.instance.status).toBe('pending_signature');

    // And it keeps retrying rather than dying, because a revoked connection is
    // usually an operator about to connect a new one.
    const report = await host.drainDue(t, s);
    expect(report.retrying + report.deadLettered).toBe(1);
    expect(report.delivered).toBe(0);
  });
});
