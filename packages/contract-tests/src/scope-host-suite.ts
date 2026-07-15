import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  dataSubjectId,
  moduleManifest,
  platformActorId,
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

// Entitlement gate (§4.3): a module whose SKU flag the tenant does not hold does
// not load — its operations do not resolve. Isolated on its own tenant so
// granting/revoking here cannot disturb the other suites' fixtures.
const billedModManifest = moduleManifest.parse({
  id: '@test/billed',
  version: '1.0.0',
  kernelContract: '^0.0.1',
  permissions: [{ key: 'billed:use', description: 'billed module permission' }],
  events: { emits: [], consumes: [] },
  migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
  attachmentTargets: [],
  entitlementKey: 'billed',
});

// Manifest-declared operation guards (K-17). Two modules, on purpose: one
// GUARDED module whose manifest declares the gate, one GATE module that
// contributes the named predicate. The guarded module registers FIRST — the
// contract says predicates resolve at invoke, not at registration, because
// registration order is caller-controlled.
const guardedModManifest = moduleManifest.parse({
  id: '@test/guarded',
  version: '1.0.0',
  kernelContract: '^0.0.1',
  permissions: [{ key: 'guarded:use', description: 'guarded permission' }],
  events: { emits: [], consumes: [] },
  migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
  attachmentTargets: [],
  entitlementKey: 'guarded',
  guards: [
    { before: 'guarded/act', predicate: 'gate/flag-set', config: { flag: 'go' } },
    // A guard whose predicate NO module contributes: the operation must fail
    // closed, never run unguarded.
    { before: 'guarded/orphan', predicate: 'gate/does-not-exist', config: {} },
  ],
});

// Operation withdrawal (K-17). Order-independence is the contract, so the suite
// withdraws one operation BEFORE its module registers and one AFTER.
const withdrawEarlyManifest = moduleManifest.parse({
  id: '@test/withdraw-early',
  version: '1.0.0',
  kernelContract: '^0.0.1',
  permissions: [{ key: 'wearly:use', description: 'early withdrawer' }],
  events: { emits: [], consumes: [] },
  migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
  attachmentTargets: [],
  entitlementKey: 'withdraw-early',
  withdraws: ['victim/a'], // @test/victim has not registered yet
});

const victimModManifest = moduleManifest.parse({
  id: '@test/victim',
  version: '1.0.0',
  kernelContract: '^0.0.1',
  permissions: [{ key: 'victim:use', description: 'victim permission' }],
  events: { emits: [], consumes: [] },
  migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
  attachmentTargets: [],
  entitlementKey: 'victim',
});

const withdrawLateManifest = moduleManifest.parse({
  id: '@test/withdraw-late',
  version: '1.0.0',
  kernelContract: '^0.0.1',
  permissions: [{ key: 'wlate:use', description: 'late withdrawer' }],
  events: { emits: [], consumes: [] },
  migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
  attachmentTargets: [],
  entitlementKey: 'withdraw-late',
  withdraws: ['victim/b'], // @test/victim already registered
});

const gateModManifest = moduleManifest.parse({
  id: '@test/gate',
  version: '1.0.0',
  kernelContract: '^0.0.1',
  permissions: [{ key: 'gate:use', description: 'gate permission' }],
  events: { emits: [], consumes: [] },
  migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
  attachmentTargets: [],
  entitlementKey: 'gate',
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
    const t3 = tenantId.parse(ulid()); // control-plane §4.1 tenant-lifecycle fixture
    const t4 = tenantId.parse(ulid()); // §4.3 entitlement-gate fixture
    const s1 = scopeId.parse(ulid());
    const s2 = scopeId.parse(ulid());
    const s3 = scopeId.parse(ulid()); // scope under t3
    const s4 = scopeId.parse(ulid()); // scope under t4
    const alice: PrincipalId = principalId.parse(ulid());
    const staff = platformActorId.parse(ulid());

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

      // Guards (K-17). The guarded module registers BEFORE the module that
      // contributes its predicate — wiring may legitimately precede the
      // implementation, so resolution is late and fails closed at invoke.
      host.registerModule({
        manifest: guardedModManifest,
        migrations: [
          { version: '0001-init', sql: 'CREATE TABLE guarded_t (v TEXT NOT NULL)' },
        ],
        operations: {
          'guarded/act': ((ctx, input: { flag?: string }) => {
            ctx.sql.exec('INSERT INTO guarded_t (v) VALUES (?)', [input?.flag ?? 'none']);
            ctx.emit({
              type: 'guarded.acted',
              schemaVersion: 1,
              entity: { entityType: 'guarded-thing', entityId: 'g1' },
              piiClass: 'none',
              payload: {},
            });
          }) as OperationHandler<never, unknown>,
          'guarded/orphan': (() => 'ran') as OperationHandler<never, unknown>,
          'guarded/rows': ((ctx) =>
            ctx.sql.query<{ v: string }>('SELECT v FROM guarded_t').map((r) => r.v)) as
            OperationHandler<never, unknown>,
          'guarded/events': ((ctx) =>
            ctx.sql.query('SELECT id FROM _substrat_outbox WHERE type = ?', ['guarded.acted'])
              .length) as OperationHandler<never, unknown>,
        },
      });

      host.registerModule({
        manifest: gateModManifest,
        predicates: {
          // The predicate sees ctx (its own transaction), the manifest config,
          // and the operation input. It THROWS to block, returns to allow.
          'gate/flag-set': (_ctx, config, input) => {
            const want = config.flag;
            const got = (input as { flag?: string } | undefined)?.flag;
            if (got !== want) throw new Error(`guard: expected flag '${String(want)}', got '${String(got)}'`);
          },
        },
      });

      // Withdrawal, both orders: early withdrawer → victim → late withdrawer.
      host.registerModule({ manifest: withdrawEarlyManifest });
      host.registerModule({
        manifest: victimModManifest,
        operations: {
          'victim/a': (() => 'a') as OperationHandler<never, unknown>,
          'victim/b': (() => 'b') as OperationHandler<never, unknown>,
          'victim/c': (() => 'c') as OperationHandler<never, unknown>,
        },
      });
      host.registerModule({ manifest: withdrawLateManifest });

      // A scope requires an existing active tenant (§4.1) — create then provision.
      host.admin.createTenant(staff, { id: t1, slug: 'tenant-one', name: 'Tenant One' });
      host.admin.createTenant(staff, { id: t2, slug: 'tenant-two', name: 'Tenant Two' });
      // Entitlements are default-deny (§4.3): t1 invokes these modules' operations,
      // so it must hold their SKU flags. (t2 only exercises bare, ungated ops.)
      for (const key of ['testmod', 'flow', 'guarded', 'victim', 'late']) {
        host.admin.grantEntitlement(staff, t1, key);
      }
      await host.provisionScope(staff, { tenantId: t1, scopeId: s1, jurisdiction: 'eu' });
      await host.provisionScope(staff, { tenantId: t2, scopeId: s2, jurisdiction: 'eu' });
    });

    afterAll(async () => {
      await fixture.cleanup();
    });

    it('provisioning is idempotent', async () => {
      await expect(
        host.provisionScope(staff, { tenantId: t1, scopeId: s1, jurisdiction: 'eu' }),
      ).resolves.toBeUndefined();
    });

    it('refuses to provision a scope under a tenant with no record (§4.1)', async () => {
      await expect(
        host.provisionScope(staff, { tenantId: tenantId.parse(ulid()), scopeId: scopeId.parse(ulid()) }),
      ).rejects.toThrow(/unknown tenant/);
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

    // -- manifest-declared operation guards (K-17) ---------------------------

    it('runs a manifest guard before the handler; a throw blocks and rolls back (K-17)', async () => {
      const stub = await host.getScope(alice, t1, s1);
      // Guard fails → the handler never ran: no row, and no event on the spine.
      await expect(stub.invoke('guarded/act', { flag: 'stop' })).rejects.toThrow(/expected flag/);
      await expect(stub.invoke<string[]>('guarded/rows')).resolves.toEqual([]);
      await expect(stub.invoke<number>('guarded/events')).resolves.toBe(0);

      // Guard passes → the handler runs, in the same transaction.
      await stub.invoke('guarded/act', { flag: 'go' });
      await expect(stub.invoke<string[]>('guarded/rows')).resolves.toEqual(['go']);
      await expect(stub.invoke<number>('guarded/events')).resolves.toBe(1);
    });

    it('fails closed when a declared guard names a predicate no module contributes', async () => {
      const stub = await host.getScope(alice, t1, s1);
      await expect(stub.invoke('guarded/orphan')).rejects.toThrow(/unknown guard predicate/);
    });

    it('rejects a predicate name already contributed by another module', () => {
      expect(() =>
        host.registerModule({
          manifest: moduleManifest.parse({
            ...gateModManifest,
            id: '@test/gate-clash',
            entitlementKey: 'gate-clash',
            permissions: [{ key: 'gateclash:use', description: 'clash' }],
          }),
          predicates: { 'gate/flag-set': () => undefined },
        }),
      ).toThrow(/already contributed/);
    });

    it('leaves unguarded operations untouched', async () => {
      const stub = await host.getScope(alice, t1, s1);
      await expect(stub.invoke<string[]>('guarded/rows')).resolves.toEqual(['go']);
    });

    // -- operation withdrawal (K-17) -----------------------------------------

    it('withdraws a default binding regardless of registration order (K-17)', async () => {
      const stub = await host.getScope(alice, t1, s1);
      // withdrawn BEFORE its module registered…
      await expect(stub.invoke('victim/a')).rejects.toThrow(/unknown operation/);
      // …and AFTER its module registered. Both are indistinguishable from an
      // operation that was never defined: fail closed, no special error class.
      await expect(stub.invoke('victim/b')).rejects.toThrow(/unknown operation/);
      // Withdrawal is per-operation and opt-in: everything else still binds.
      await expect(stub.invoke<string>('victim/c')).resolves.toBe('c');
    });

    it('rejects a module withdrawing its own operation', () => {
      expect(() =>
        host.registerModule({
          manifest: moduleManifest.parse({
            ...victimModManifest,
            id: '@test/self-withdrawer',
            entitlementKey: 'self-withdrawer',
            permissions: [{ key: 'selfw:use', description: 'self' }],
            withdraws: ['selfw/op'],
          }),
          operations: { 'selfw/op': (() => 'x') as OperationHandler<never, unknown> },
        }),
      ).toThrow(/withdraws its own operation/);
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

    // -- tenant registry + lifecycle (control-plane.md §4.1) -----------------

    it('creates a tenant record, idempotently; only real creates are audited', () => {
      host.admin.createTenant(staff, { id: t3, slug: 'acme-co', name: 'Acme Co' });
      host.admin.createTenant(staff, { id: t3, slug: 'acme-co', name: 'Acme Co' }); // no-op
      expect(host.admin.getTenant(t3)).toMatchObject({
        id: t3,
        slug: 'acme-co',
        name: 'Acme Co',
        status: 'active',
      });
      expect(host.admin.listTenants().filter((x) => x.id === t3)).toHaveLength(1);
      const creates = host.admin
        .auditLog({ tenantId: t3 })
        .filter((r) => r.action === 'createTenant');
      expect(creates).toHaveLength(1); // the idempotent no-op left no row
      expect(creates[0]!.actor).toBe(staff);
    });

    it('suspends a tenant: getScope fails closed for its scopes; reactivation restores (§4.1)', async () => {
      await host.provisionScope(staff, { tenantId: t3, scopeId: s3, jurisdiction: 'eu' });
      await expect(host.getScope(alice, t3, s3)).resolves.toBeDefined();

      host.admin.setTenantStatus(staff, t3, 'suspended');
      await expect(host.getScope(alice, t3, s3)).rejects.toThrow(/not active/);

      host.admin.setTenantStatus(staff, t3, 'active');
      await expect(host.getScope(alice, t3, s3)).resolves.toBeDefined();
    });

    it('records setTenantStatus with before/after status', () => {
      const transitions = host.admin
        .auditLog({ tenantId: t3 })
        .filter((r) => r.action === 'setTenantStatus');
      expect(transitions.length).toBeGreaterThanOrEqual(2);
      const suspend = transitions.find(
        (r) => (r.after as { status: string }).status === 'suspended',
      )!;
      expect((suspend.before as { status: string }).status).toBe('active');
    });

    it('rejects a status transition on an unknown tenant', () => {
      expect(() =>
        host.admin.setTenantStatus(staff, tenantId.parse(ulid()), 'suspended'),
      ).toThrow(/unknown tenant/);
    });

    // -- scope lifecycle (control-plane.md §4.2) ------------------------------

    it('suspend/unsuspend a scope gates getScope for that scope alone (§4.2)', async () => {
      // s3 is active (reactivated above). Suspending it fails closed…
      host.admin.suspendScope(staff, t3, s3);
      await expect(host.getScope(alice, t3, s3)).rejects.toThrow(/scope not active/);
      // …while a sibling scope under the same tenant is untouched.
      const sibling = scopeId.parse(ulid());
      await host.provisionScope(staff, { tenantId: t3, scopeId: sibling, jurisdiction: 'eu' });
      await expect(host.getScope(alice, t3, sibling)).resolves.toBeDefined();
      // Unsuspend restores.
      host.admin.unsuspendScope(staff, t3, s3);
      await expect(host.getScope(alice, t3, s3)).resolves.toBeDefined();
    });

    it('archive then un-archive is an explicit audited restore (§4.2)', async () => {
      host.admin.archiveScope(staff, t3, s3);
      await expect(host.getScope(alice, t3, s3)).rejects.toThrow(/scope not active/);
      host.admin.unarchiveScope(staff, t3, s3);
      await expect(host.getScope(alice, t3, s3)).resolves.toBeDefined();

      const transitions = host.admin
        .auditLog({ tenantId: t3 })
        .filter((r) => r.action === 'archiveScope' || r.action === 'unarchiveScope');
      expect(transitions.map((r) => r.action)).toEqual(
        expect.arrayContaining(['archiveScope', 'unarchiveScope']),
      );
      for (const r of transitions) {
        expect(r.scopeId).toBe(s3);
        expect(r.actor).toBe(staff);
      }
    });

    it('rejects an illegal scope transition, fail closed (§4.2)', () => {
      // s3 is active — you cannot un-archive an active scope.
      expect(() => host.admin.unarchiveScope(staff, t3, s3)).toThrow(/illegal scope transition/);
    });

    it('rejects a lifecycle transition on a scope not under the named tenant', () => {
      expect(() => host.admin.suspendScope(staff, t1, s3)).toThrow(/unknown scope for tenant/);
    });

    // -- entitlement gate (control-plane.md §4.3) -----------------------------

    it('gates a module operation on the tenant holding its SKU flag (§4.3)', async () => {
      host.registerModule({
        manifest: billedModManifest,
        operations: {
          'billed/act': (() => 'ran') as OperationHandler<never, unknown>,
        },
      });
      host.admin.createTenant(staff, { id: t4, slug: 'billed-co', name: 'Billed Co' });
      await host.provisionScope(staff, { tenantId: t4, scopeId: s4, jurisdiction: 'eu' });
      const stub = await host.getScope(alice, t4, s4);

      // Default-deny: the flag is not held, so the operation does not resolve.
      await expect(stub.invoke('billed/act')).rejects.toThrow(/not entitled/);

      // Granting the flag loads the module for this tenant.
      host.admin.grantEntitlement(staff, t4, 'billed');
      await expect(stub.invoke<string>('billed/act')).resolves.toBe('ran');
      expect(host.admin.listEntitlements(t4)).toContain('billed');

      // Revoking it takes the operation away again — as if never registered.
      host.admin.revokeEntitlement(staff, t4, 'billed');
      await expect(stub.invoke('billed/act')).rejects.toThrow(/not entitled/);
      expect(host.admin.listEntitlements(t4)).not.toContain('billed');
    });

    it('audits grant/revoke idempotently and records the SKU flag', () => {
      // Re-grant twice: only the first is a real change, so only one row.
      host.admin.grantEntitlement(staff, t4, 'audited-sku');
      host.admin.grantEntitlement(staff, t4, 'audited-sku');
      const grants = host.admin
        .auditLog({ tenantId: t4 })
        .filter((r) => r.action === 'grantEntitlement' && (r.after as { entitlementKey: string }).entitlementKey === 'audited-sku');
      expect(grants).toHaveLength(1);
      expect(grants[0]!.actor).toBe(staff);

      host.admin.revokeEntitlement(staff, t4, 'audited-sku');
      const revokes = host.admin
        .auditLog({ tenantId: t4 })
        .filter((r) => r.action === 'revokeEntitlement');
      expect(revokes.length).toBeGreaterThanOrEqual(1);
      expect((revokes[revokes.length - 1]!.before as { entitlementKey: string }).entitlementKey).toBe(
        'audited-sku',
      );
    });

    it('leaves bare (module-less) operations ungated', async () => {
      // test/read-counter was registered via defineOperation, no manifest — it
      // must resolve regardless of entitlements.
      const stub = await host.getScope(alice, t1, s1);
      await expect(stub.invoke('test/read-counter')).resolves.toBeTypeOf('number');
    });
  });
}
