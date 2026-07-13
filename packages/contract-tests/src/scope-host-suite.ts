import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  dataSubjectId,
  moduleManifest,
  principalId,
  scopeId,
  tenantId,
  type PrincipalId,
  type ScopeId,
  type TenantId,
} from '@substrat-run/contracts';
import { ulid, type OperationHandler, type ScopeHost } from '@substrat-run/kernel';

const testModManifest = moduleManifest.parse({
  id: '@test/mod',
  version: '1.0.0',
  kernelContract: '^0.0.1',
  permissions: [{ key: 'testmod:use', description: 'test permission' }],
  events: { emits: [], consumes: [] },
  migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
  attachmentTargets: [],
  entityRelations: [{ entityType: 'item', parentType: 'box' }],
  entitlementKey: 'testmod',
});

const flowModManifest = moduleManifest.parse({
  id: '@test/flow',
  version: '1.0.0',
  kernelContract: '^0.0.1',
  permissions: [{ key: 'flow:use', description: 'flow permission' }],
  events: {
    emits: [
      { type: 'flow.step1', schemaVersion: 1 },
      { type: 'flow.step2', schemaVersion: 1 },
    ],
    consumes: [
      { type: 'flow.step1', schemaVersion: 1 },
      { type: 'flow.step2', schemaVersion: 1 },
    ],
  },
  migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
  attachmentTargets: [],
  entitlementKey: 'flow',
});

const lateModManifest = moduleManifest.parse({
  id: '@test/late',
  version: '1.0.0',
  kernelContract: '^0.0.1',
  permissions: [{ key: 'late:use', description: 'late module permission' }],
  events: { emits: [], consumes: [] },
  migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
  attachmentTargets: [],
  entitlementKey: 'late',
});

const addItem: OperationHandler<{ id: string; box: string }, void> = (ctx, input) => {
  ctx.sql.exec('INSERT INTO testmod_items (id, box) VALUES (?, ?)', [input.id, input.box]);
  ctx.link({ entityType: 'item', entityId: input.id }, { entityType: 'box', entityId: input.box });
};

const relinkItem: OperationHandler<{ id: string; box: string }, void> = (ctx, input) => {
  ctx.link({ entityType: 'item', entityId: input.id }, { entityType: 'box', entityId: input.box });
};

const linkUndeclared: OperationHandler<undefined, void> = (ctx) => {
  ctx.link({ entityType: 'box', entityId: 'b1' }, { entityType: 'item', entityId: 'i1' });
};

const readJournal: OperationHandler<undefined, { module_id: string; version: string }[]> = (
  ctx,
) => ctx.sql.query('SELECT module_id, version FROM _substrat_migrations ORDER BY module_id');

const readTuples: OperationHandler<undefined, { subject: string; relation: string; object: string }[]> =
  (ctx) => ctx.sql.query('SELECT subject, relation, object FROM _substrat_tuples ORDER BY subject');

export interface ScopeHostFixture {
  host: ScopeHost;
  cleanup(): Promise<void>;
}

interface OutboxRow {
  id: string;
  type: string;
  occurred_at: string;
  tenant_id: string;
  scope_id: string;
  pii_class: string;
  subject_id: string | null;
}

/**
 * The scope-host contract suite (design doc §11). Every adapter — pure SQLite,
 * Cloudflare, and any future one — must pass this unchanged (D-14). If an
 * adapter needs the suite modified, the contract changed and that is a
 * decision, not a patch.
 */
export function scopeHostContractSuite(
  adapterName: string,
  makeFixture: () => Promise<ScopeHostFixture>,
): void {
  describe(`scope-host contract: ${adapterName}`, () => {
    let fixture: ScopeHostFixture;
    let host: ScopeHost;
    const t1 = tenantId.parse(ulid());
    const t2 = tenantId.parse(ulid());
    const s1 = scopeId.parse(ulid());
    const s2 = scopeId.parse(ulid());
    const alice: PrincipalId = principalId.parse(ulid());

    beforeAll(async () => {
      fixture = await makeFixture();
      host = fixture.host;

      host.defineOperation<undefined, void>('test/init-counter', (ctx) => {
        ctx.sql.exec('CREATE TABLE IF NOT EXISTS counter (n INTEGER NOT NULL)');
        ctx.sql.exec('DELETE FROM counter');
        ctx.sql.exec('INSERT INTO counter (n) VALUES (0)');
      });

      // Read → await → write. Under interleaving this loses updates; under
      // strict serialization it cannot.
      host.defineOperation<undefined, void>('test/slow-increment', async (ctx) => {
        const [row] = ctx.sql.query<{ n: number }>('SELECT n FROM counter');
        await new Promise((r) => setTimeout(r, 5));
        ctx.sql.exec('UPDATE counter SET n = ?', [row!.n + 1]);
      });

      host.defineOperation<undefined, number>('test/read-counter', (ctx) => {
        const [row] = ctx.sql.query<{ n: number }>('SELECT n FROM counter');
        return row!.n;
      });

      const stash: { value?: { items: string[] } } = {};
      host.defineOperation<{ items: string[] }, void>('test/stash', (_ctx, input) => {
        stash.value = input;
      });
      host.defineOperation<undefined, { items: string[] }>('test/read-stash', () => {
        return stash.value!;
      });

      host.defineOperation<{ subject?: string }, void>('test/emit-event', (ctx, input) => {
        ctx.emit({
          type: 'test.happened',
          schemaVersion: 1,
          entity: { entityType: 'test-thing', entityId: 'x1' },
          piiClass: input?.subject ? 'pseudonymous' : 'none',
          ...(input?.subject ? { subjectId: dataSubjectId.parse(input.subject) } : {}),
          payload: { hello: 'world' },
        });
      });

      host.defineOperation<undefined, void>('test/emit-unclassified-pii', (ctx) => {
        // piiClass 'direct' without subjectId — must be rejected at emit (§6.1)
        ctx.emit({
          type: 'test.bad',
          schemaVersion: 1,
          entity: { entityType: 'test-thing', entityId: 'x2' },
          piiClass: 'direct',
          payload: {},
        });
      });

      host.defineOperation<undefined, OutboxRow[]>('test/read-outbox', (ctx) =>
        ctx.sql.query<OutboxRow>('SELECT * FROM _substrat_outbox ORDER BY id'),
      );

      host.defineOperation<{ v: string }, void>('test/write-marker', (ctx, input) => {
        ctx.sql.exec('CREATE TABLE IF NOT EXISTS marker (v TEXT NOT NULL)');
        ctx.sql.exec('INSERT INTO marker (v) VALUES (?)', [input.v]);
      });
      host.defineOperation<undefined, string[]>('test/read-markers', (ctx) => {
        ctx.sql.exec('CREATE TABLE IF NOT EXISTS marker (v TEXT NOT NULL)');
        return ctx.sql.query<{ v: string }>('SELECT v FROM marker').map((r) => r.v);
      });

      host.defineOperation<undefined, void>('test/atomic-init', (ctx) => {
        ctx.sql.exec('CREATE TABLE IF NOT EXISTS atomic_t (n INTEGER NOT NULL)');
      });
      host.defineOperation<undefined, void>('test/atomic-fail', (ctx) => {
        ctx.sql.exec('INSERT INTO atomic_t (n) VALUES (1)');
        ctx.emit({
          type: 'test.atomic',
          schemaVersion: 1,
          entity: { entityType: 'test-thing', entityId: 'x9' },
          piiClass: 'none',
          payload: {},
        });
        throw new Error('boom');
      });
      host.defineOperation<undefined, { rows: number; events: number }>(
        'test/atomic-read',
        (ctx) => ({
          rows: ctx.sql.query<{ n: number }>('SELECT n FROM atomic_t').length,
          events: ctx.sql.query('SELECT id FROM _substrat_outbox WHERE type = ?', ['test.atomic'])
            .length,
        }),
      );

      host.registerModule({
        manifest: testModManifest,
        migrations: [
          {
            version: '0001-init',
            sql: 'CREATE TABLE testmod_items (id TEXT PRIMARY KEY, box TEXT NOT NULL)',
          },
        ],
        operations: {
          'testmod/add': addItem,
          'testmod/relink': relinkItem,
          'testmod/link-undeclared': linkUndeclared,
          'testmod/read-journal': readJournal,
          'testmod/read-tuples': readTuples,
        },
      });

      host.registerModule({
        manifest: flowModManifest,
        migrations: [
          {
            version: '0001-init',
            sql: 'CREATE TABLE flow_log (event_id TEXT PRIMARY KEY, type TEXT NOT NULL)',
          },
        ],
        operations: {
          'flow/produce': ((ctx) => {
            ctx.emit({
              type: 'flow.step1',
              schemaVersion: 1,
              entity: { entityType: 'flow-thing', entityId: 'f1' },
              piiClass: 'none',
              payload: {},
            });
          }) as OperationHandler<never, unknown>,
          'flow/log': ((ctx) =>
            ctx.sql.query(
              'SELECT event_id, type FROM flow_log ORDER BY event_id',
            )) as OperationHandler<never, unknown>,
          'flow/deliveries': ((ctx) =>
            ctx.sql.query(
              `SELECT event_id, consumer_module, error FROM _substrat_deliveries
               WHERE consumer_module = '@test/flow' ORDER BY event_id`,
            )) as OperationHandler<never, unknown>,
          'flow/step2-actors': ((ctx) =>
            ctx.sql.query(
              `SELECT actor FROM _substrat_outbox WHERE type = 'flow.step2'`,
            )) as OperationHandler<never, unknown>,
        },
        consumers: {
          'flow.step1': (ctx, event) => {
            ctx.sql.exec('INSERT INTO flow_log (event_id, type) VALUES (?, ?)', [
              event.id,
              event.type,
            ]);
            ctx.emit({
              type: 'flow.step2',
              schemaVersion: 1,
              entity: event.entity,
              piiClass: 'none',
              payload: {},
            });
          },
          'flow.step2': (ctx, event) => {
            ctx.sql.exec('INSERT INTO flow_log (event_id, type) VALUES (?, ?)', [
              event.id,
              event.type,
            ]);
          },
        },
      });

      await host.provisionScope({ tenantId: t1, scopeId: s1, jurisdiction: 'eu' });
      await host.provisionScope({ tenantId: t2, scopeId: s2, jurisdiction: 'eu' });
    });

    afterAll(async () => {
      await fixture.cleanup();
    });

    it('provisioning is idempotent', async () => {
      await expect(
        host.provisionScope({ tenantId: t1, scopeId: s1, jurisdiction: 'eu' }),
      ).resolves.toBeUndefined();
    });

    it('fails closed on a mismatched (tenantId, scopeId) pair (K-3)', async () => {
      await expect(host.getScope(alice, t2, s1)).rejects.toThrow();
      await expect(
        host.getScope(alice, t1, scopeId.parse(ulid())),
      ).rejects.toThrow();
    });

    it('serializes operations strictly per scope (K-6)', async () => {
      const stub = await host.getScope(alice, t1, s1);
      await stub.invoke('test/init-counter');
      await Promise.all(
        Array.from({ length: 10 }, () => stub.invoke('test/slow-increment')),
      );
      await expect(stub.invoke('test/read-counter')).resolves.toBe(10);
    });

    it('clones inputs and results across the stub boundary (K-6)', async () => {
      const stub = await host.getScope(alice, t1, s1);
      const input = { items: ['a'] };
      await stub.invoke('test/stash', input);
      input.items.push('MUTATED-AFTER-CALL');
      const first = await stub.invoke<{ items: string[] }>('test/read-stash');
      expect(first.items).toEqual(['a']);
      first.items.push('MUTATED-RESULT');
      const second = await stub.invoke<{ items: string[] }>('test/read-stash');
      expect(second.items).toEqual(['a']);
    });

    it('stamps the event envelope kernel-side (§6.1)', async () => {
      const stub = await host.getScope(alice, t1, s1);
      await stub.invoke('test/emit-event');
      const rows = await stub.invoke<OutboxRow[]>('test/read-outbox');
      expect(rows.length).toBeGreaterThan(0);
      const row = rows[rows.length - 1]!;
      expect(row.tenant_id).toBe(t1);
      expect(row.scope_id).toBe(s1);
      expect(row.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
      expect(new Date(row.occurred_at).getTime()).not.toBeNaN();
      expect(row.pii_class).toBe('none');
    });

    it('rejects PII-classed events without a subjectId (§6.1)', async () => {
      const stub = await host.getScope(alice, t1, s1);
      await expect(stub.invoke('test/emit-unclassified-pii')).rejects.toThrow(/subjectId/);
    });

    it('accepts PII-classed events with a subjectId', async () => {
      const stub = await host.getScope(alice, t1, s1);
      await expect(
        stub.invoke('test/emit-event', { subject: ulid() }),
      ).resolves.toBeUndefined();
    });

    it('isolates scope storage: a write in one scope is invisible in another', async () => {
      const stub1 = await host.getScope(alice, t1, s1);
      const stub2 = await host.getScope(alice, t2, s2);
      await stub1.invoke('test/write-marker', { v: 'only-in-s1' });
      await expect(stub2.invoke('test/read-markers')).resolves.toEqual([]);
      await expect(stub1.invoke('test/read-markers')).resolves.toEqual(['only-in-s1']);
    });

    it('rejects unknown operations', async () => {
      const stub = await host.getScope(alice, t1, s1);
      await expect(stub.invoke('test/does-not-exist')).rejects.toThrow(/unknown operation/);
    });

    it('rolls back the entire operation when the handler throws (K-4)', async () => {
      const stub = await host.getScope(alice, t1, s1);
      await stub.invoke('test/atomic-init');
      await expect(stub.invoke('test/atomic-fail')).rejects.toThrow('boom');
      // Neither the write NOR its emitted event survive — one transaction.
      await expect(stub.invoke('test/atomic-read')).resolves.toEqual({ rows: 0, events: 0 });
    });

    it('applies module migrations lazily and journals them per (module, version)', async () => {
      const stub = await host.getScope(alice, t1, s1);
      const journal = await stub.invoke<{ module_id: string; version: string }[]>(
        'testmod/read-journal',
      );
      expect(journal).toContainEqual({ module_id: '@test/mod', version: '0001-init' });
      // Idempotent: another wake applies nothing twice.
      const again = await host.getScope(alice, t1, s1);
      const journal2 = await again.invoke<{ module_id: string; version: string }[]>(
        'testmod/read-journal',
      );
      expect(journal2.filter((r) => r.module_id === '@test/mod')).toHaveLength(1);
    });

    it('applies migrations of modules registered after a scope was first accessed', async () => {
      host.registerModule({
        manifest: lateModManifest,
        migrations: [
          { version: '0001-init', sql: 'CREATE TABLE late_t (id TEXT PRIMARY KEY)' },
        ],
        operations: {
          'late/check': ((ctx) =>
            ctx.sql.query(`SELECT name FROM sqlite_master WHERE name = 'late_t'`)
              .length) as OperationHandler<never, unknown>,
        },
      });
      const stub = await host.getScope(alice, t1, s1);
      await expect(stub.invoke('late/check')).resolves.toBe(1);
      const journal = await stub.invoke<{ module_id: string; version: string }[]>(
        'testmod/read-journal',
      );
      expect(journal).toContainEqual({ module_id: '@test/late', version: '0001-init' });
    });

    it('rejects duplicate module registration', () => {
      expect(() => host.registerModule({ manifest: testModManifest })).toThrow(
        /already registered/,
      );
    });

    it('links declared entity relations, idempotently (K-16)', async () => {
      const stub = await host.getScope(alice, t1, s1);
      await stub.invoke('testmod/add', { id: 'i1', box: 'b1' });
      await stub.invoke('testmod/relink', { id: 'i1', box: 'b1' }); // no duplicate
      const tuples = await stub.invoke<{ subject: string; relation: string; object: string }[]>(
        'testmod/read-tuples',
      );
      expect(tuples.filter((t) => t.subject === 'item:i1')).toEqual([
        { subject: 'item:i1', relation: 'parent', object: 'box:b1' },
      ]);
    });

    it('rejects links for undeclared entity relations', async () => {
      const stub = await host.getScope(alice, t1, s1);
      await expect(stub.invoke('testmod/link-undeclared')).rejects.toThrow(
        /undeclared entity relation/,
      );
    });

    it('dispatches events to consumers, cascading, exactly once per (event, consumer)', async () => {
      const stub = await host.getScope(alice, t1, s1);
      await stub.invoke('flow/produce');
      const log = await stub.invoke<{ event_id: string; type: string }[]>('flow/log');
      expect(log.map((r) => r.type).sort()).toEqual(['flow.step1', 'flow.step2']);
      const deliveries = await stub.invoke<{ event_id: string; error: string | null }[]>(
        'flow/deliveries',
      );
      expect(deliveries).toHaveLength(2);
      expect(deliveries.every((d) => d.error === null)).toBe(true);

      await stub.invoke('flow/produce');
      const log2 = await stub.invoke<{ event_id: string; type: string }[]>('flow/log');
      expect(log2).toHaveLength(4); // two new, none duplicated
      await expect(stub.invoke('flow/deliveries')).resolves.toHaveLength(4);
    });

    it('runs consumers under a system actor — consumer-emitted events carry it', async () => {
      const stub = await host.getScope(alice, t1, s1);
      const actors = await stub.invoke<{ actor: string }[]>('flow/step2-actors');
      expect(actors.length).toBeGreaterThan(0);
      for (const row of actors) {
        expect(JSON.parse(row.actor)).toEqual({ system: '@test/flow' });
      }
    });
  });
}
