import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  moduleManifest,
  orgId,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  type OrgId,
  type PrincipalId,
  type TenantId,
} from '@substrat-run/contracts';
import { ulid, type OperationHandler, type ScopeHost } from '@substrat-run/kernel';
import {
  billedMod,
  contractTestBareOps,
  contractTestInitialModules,
  gateModManifest,
  lateMod,
  testModManifest,
  victimModManifest,
} from './modules.js';

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

/** Adapter capability flags — everything an adapter cannot honor identically. */
export interface ScopeHostSuiteOptions {
  /**
   * Whether the adapter supports registering a module AFTER a scope was first
   * accessed (runtime registration). The pure adapter does; the Cloudflare
   * adapter closes its ScopeDO over a code-time module set, so it does not. When
   * `false`, the single late-registration test is skipped — every other test is
   * shared unchanged (D-14).
   */
  supportsRuntimeRegistration?: boolean;
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
  opts: ScopeHostSuiteOptions = {},
): void {
  const supportsRuntimeRegistration = opts.supportsRuntimeRegistration !== false;

  describe(`scope-host contract: ${adapterName}`, () => {
    let fixture: ScopeHostFixture;
    let host: ScopeHost;
    const t1 = tenantId.parse(ulid());
    const t2 = tenantId.parse(ulid());
    const t3 = tenantId.parse(ulid()); // control-plane §4.1 tenant-lifecycle fixture
    const t4 = tenantId.parse(ulid()); // §4.3 entitlement-gate fixture
    const t5 = tenantId.parse(ulid()); // §3.2/§4.5 directory-read fixture
    const s1 = scopeId.parse(ulid());
    const s2 = scopeId.parse(ulid());
    const s3 = scopeId.parse(ulid()); // scope under t3
    const s4 = scopeId.parse(ulid()); // scope under t4
    const alice: PrincipalId = principalId.parse(ulid());
    const staff = platformActorId.parse(ulid());

    beforeAll(async () => {
      fixture = await makeFixture();
      host = fixture.host;

      // Bare operations (no manifest) and the initial module set, registered in
      // the order the contract fixes (see contractTestInitialModules).
      for (const [name, handler] of Object.entries(contractTestBareOps)) {
        host.defineOperation(name, handler);
      }
      for (const reg of contractTestInitialModules) {
        host.registerModule(reg);
      }

      // The connector seam's out-of-band half (K-22 §4.2). Host code, not module
      // code: it holds platform authority, which is exactly what a module must
      // never have. Idempotent because delivery is at-least-once.
      host.registerExecutor('member-adder', 'member.add-requested', async (admin, event) => {
        const p = event.payload as { principal: string; orgId: string; tenantId: string };
        await admin.addMember(
          staff,
          p.tenantId as TenantId,
          p.principal as PrincipalId,
          p.orgId as OrgId,
        );
      });

      // A scope requires an existing active tenant (§4.1) — create then provision.
      await host.admin.createTenant(staff, { id: t1, slug: 'tenant-one', name: 'Tenant One' });
      await host.admin.createTenant(staff, { id: t2, slug: 'tenant-two', name: 'Tenant Two' });
      // Entitlements are default-deny (§4.3): t1 invokes these modules' operations,
      // so it must hold their SKU flags. (t2 only exercises bare, ungated ops.)
      for (const key of ['testmod', 'flow', 'guarded', 'victim', 'late', 'connector']) {
        await host.admin.grantEntitlement(staff, t1, key);
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
        host.provisionScope(staff, {
          tenantId: tenantId.parse(ulid()),
          scopeId: scopeId.parse(ulid()),
        }),
      ).rejects.toThrow(/unknown tenant/);
    });

    it('fails closed on a mismatched (tenantId, scopeId) pair (K-3)', async () => {
      await expect(host.getScope(alice, t2, s1)).rejects.toThrow();
      await expect(host.getScope(alice, t1, scopeId.parse(ulid()))).rejects.toThrow();
    });

    it('serializes operations strictly per scope (K-6)', async () => {
      const stub = await host.getScope(alice, t1, s1);
      await stub.invoke('test/init-counter');
      await Promise.all(Array.from({ length: 10 }, () => stub.invoke('test/slow-increment')));
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
      await expect(stub.invoke('test/emit-event', { subject: ulid() })).resolves.toBeUndefined();
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

    it.runIf(supportsRuntimeRegistration)(
      'applies migrations of modules registered after a scope was first accessed',
      async () => {
        host.registerModule(lateMod);
        const stub = await host.getScope(alice, t1, s1);
        await expect(stub.invoke('late/check')).resolves.toBe(1);
        const journal = await stub.invoke<{ module_id: string; version: string }[]>(
          'testmod/read-journal',
        );
        expect(journal).toContainEqual({ module_id: '@test/late', version: '0001-init' });
      },
    );

    // -- the connector seam (K-22 §4.2) --------------------------------------
    // A module asks, inside its transaction, for an effect it cannot perform:
    // membership is tenant-wide and lives in the directory, outside this scope's
    // serialization domain. A privileged executor effects it through HostAdmin.

    it('effects a module\'s request through an executor, and correlates the trail', async () => {
      const org = orgId.parse(ulid());
      const joiner = principalId.parse(ulid());
      await host.admin.createOrg(staff, { id: org, tenantId: t1, slug: 'seam', name: 'Seam' });

      const stub = await host.getScope(alice, t1, s1);
      await stub.invoke('connector/request-member', { principal: joiner, orgId: org });

      // Prompt dispatch: effected by the time the request returns, not on a timer.
      const members = await host.admin.listMembers(staff, t1, org);
      expect(members.map((m) => m.principal)).toEqual([joiner]);

      // The two halves join. The executor's admin row carries the id of the event
      // that caused it, which is what stops the split trail being unreadable —
      // control-plane.md §3 named that as the main cost of this pattern.
      const added = (await host.admin.auditLog(staff, { tenantId: t1 })).find(
        (e) => e.action === 'addMember' && JSON.stringify(e.after).includes(joiner),
      );
      expect(added?.causedBy).toEqual(expect.any(String));

      // A staff member acting directly caused nothing but themselves.
      const orgRow = (await host.admin.auditLog(staff, { tenantId: t1 })).find(
        (e) => e.action === 'createOrg',
      );
      expect(orgRow?.causedBy).toBeNull();
    });

    it('effects nothing when the emitting transaction rolls back', async () => {
      // The property the connector is chosen FOR. `ctx.emit` commits with the
      // domain write, so a rollback leaves no event and nothing to effect. An
      // in-scope cross-DO write could not offer this: it could land in the
      // directory and then be orphaned by the scope's rollback.
      const org = orgId.parse(ulid());
      const ghost = principalId.parse(ulid());
      await host.admin.createOrg(staff, { id: org, tenantId: t1, slug: 'ghost', name: 'Ghost' });

      const stub = await host.getScope(alice, t1, s1);
      await expect(
        stub.invoke('connector/request-and-throw', { principal: ghost, orgId: org }),
      ).rejects.toThrow(/deliberate failure/);

      expect(await host.admin.listMembers(staff, t1, org)).toEqual([]);
    });

    it('delivers each event to an executor exactly once', async () => {
      // At-least-once with a journal, so a second dispatch pass must not re-effect.
      // Membership is idempotent anyway; the audit trail is what would show a
      // double-run, and it must not.
      const org = orgId.parse(ulid());
      const once = principalId.parse(ulid());
      await host.admin.createOrg(staff, { id: org, tenantId: t1, slug: 'once', name: 'Once' });

      const stub = await host.getScope(alice, t1, s1);
      await stub.invoke('connector/request-member', { principal: once, orgId: org });
      // Another operation on the same scope drains the outbox again.
      await stub.invoke('connector/requests');

      const rows = (await host.admin.auditLog(staff, { tenantId: t1 })).filter(
        (e) => e.action === 'addMember' && JSON.stringify(e.after).includes(once),
      );
      expect(rows).toHaveLength(1);
    });

    // -- vertical + version registry (#31) -----------------------------------
    // A scope binds to a VERSION, so dev/staging/prod are the same vertical pinned
    // differently. The invariant that earns the registry its keep is that a push
    // is not a deploy.

    it('publishes a version as pending, and refuses to bind it until admitted', async () => {
      const versionId = ulid();
      await host.admin.registerVertical(staff, {
        slug: 'callout',
        name: 'Callout',
        source: 'builtin',
      });
      await host.admin.publishVersion(staff, {
        id: versionId,
        verticalSlug: 'callout',
        version: '1.0.0',
        manifestDigest: 'm1',
        permissionDigest: 'p1',
        migrationDigest: 'g1',
        deploymentRef: null,
      });

      const [published] = await host.admin.listVersions(staff, 'callout');
      expect(published?.admission).toBe('pending');

      // The refusal the registry exists for. Without it "a push lands pending" is
      // a convention, and D-30's lockstep-upgrade argument is that conventions are
      // what we cannot afford here.
      await expect(host.admin.bindScopeVersion(staff, t1, s1, versionId)).rejects.toThrow(
        /pending, not admitted/,
      );

      await host.admin.admitVersion(staff, versionId);
      await host.admin.bindScopeVersion(staff, t1, s1, versionId);

      const scope = await host.admin.getScopeRecord(staff, t1, s1);
      expect(scope?.verticalVersionId).toBe(versionId);
      // The slug is denormalized alongside, so the console and the audit target
      // keep reading a label that survives the version being superseded.
      expect(scope?.vertical).toBe('callout');
    });

    it('refuses to bind a rejected version, and rejection is terminal', async () => {
      const versionId = ulid();
      await host.admin.publishVersion(staff, {
        id: versionId,
        verticalSlug: 'callout',
        version: '1.1.0-bad',
        manifestDigest: 'm2',
        permissionDigest: 'p2',
        migrationDigest: 'g2',
        deploymentRef: null,
      });
      await host.admin.rejectVersion(staff, versionId, 'permission diff widened a role');
      await expect(host.admin.bindScopeVersion(staff, t1, s1, versionId)).rejects.toThrow(
        /rejected, not admitted/,
      );
      // Terminal: a rejected version is not resurrected, a new one is published.
      await expect(host.admin.admitVersion(staff, versionId)).rejects.toThrow(/was rejected/);
      const rejected = (await host.admin.listVersions(staff, 'callout')).find(
        (v) => v.id === versionId,
      );
      expect(rejected?.admissionNote).toContain('widened a role');
    });

    it('carries the digests promotion compares', async () => {
      // "Has the permission surface changed between what is in prod and what I am
      // promoting?" is a string comparison here. Today it is a person remembering
      // to look, and a checkpoint that can be skipped is not a checkpoint.
      const versions = await host.admin.listVersions(staff, 'callout');
      for (const v of versions) {
        expect(v.manifestDigest).toEqual(expect.any(String));
        expect(v.permissionDigest).toEqual(expect.any(String));
        expect(v.migrationDigest).toEqual(expect.any(String));
      }
    });

    it('refuses a version for a vertical nobody registered', async () => {
      await expect(
        host.admin.publishVersion(staff, {
          id: ulid(),
          verticalSlug: 'ghost',
          version: '1.0.0',
          manifestDigest: 'm',
          permissionDigest: 'p',
          migrationDigest: 'g',
          deploymentRef: null,
        }),
      ).rejects.toThrow(/unknown vertical/);
    });

    it('rejects duplicate module registration', () => {
      expect(() => host.registerModule({ manifest: testModManifest })).toThrow(/already registered/);
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

    it('creates a tenant record, idempotently; only real creates are audited', async () => {
      await host.admin.createTenant(staff, { id: t3, slug: 'acme-co', name: 'Acme Co' });
      await host.admin.createTenant(staff, { id: t3, slug: 'acme-co', name: 'Acme Co' }); // no-op
      expect(await host.admin.getTenant(staff, t3)).toMatchObject({
        id: t3,
        slug: 'acme-co',
        name: 'Acme Co',
        status: 'active',
      });
      expect((await host.admin.listTenants(staff)).filter((x) => x.id === t3)).toHaveLength(1);
      const creates = (await host.admin.auditLog(staff, { tenantId: t3 })).filter(
        (r) => r.action === 'createTenant',
      );
      expect(creates).toHaveLength(1); // the idempotent no-op left no row
      expect(creates[0]!.actor).toBe(staff);
    });

    it('suspends a tenant: getScope fails closed for its scopes; reactivation restores (§4.1)', async () => {
      await host.provisionScope(staff, { tenantId: t3, scopeId: s3, jurisdiction: 'eu' });
      await expect(host.getScope(alice, t3, s3)).resolves.toBeDefined();

      await host.admin.setTenantStatus(staff, t3, 'suspended');
      await expect(host.getScope(alice, t3, s3)).rejects.toThrow(/not active/);

      await host.admin.setTenantStatus(staff, t3, 'active');
      await expect(host.getScope(alice, t3, s3)).resolves.toBeDefined();
    });

    it('records setTenantStatus with before/after status', async () => {
      const transitions = (await host.admin.auditLog(staff, { tenantId: t3 })).filter(
        (r) => r.action === 'setTenantStatus',
      );
      expect(transitions.length).toBeGreaterThanOrEqual(2);
      const suspend = transitions.find(
        (r) => (r.after as { status: string }).status === 'suspended',
      )!;
      expect((suspend.before as { status: string }).status).toBe('active');
    });

    it('rejects a status transition on an unknown tenant', async () => {
      await expect(
        host.admin.setTenantStatus(staff, tenantId.parse(ulid()), 'suspended'),
      ).rejects.toThrow(/unknown tenant/);
    });

    // -- scope lifecycle (control-plane.md §4.2) ------------------------------

    it('suspend/unsuspend a scope gates getScope for that scope alone (§4.2)', async () => {
      // s3 is active (reactivated above). Suspending it fails closed…
      await host.admin.suspendScope(staff, t3, s3);
      await expect(host.getScope(alice, t3, s3)).rejects.toThrow(/scope not active/);
      // …while a sibling scope under the same tenant is untouched.
      const sibling = scopeId.parse(ulid());
      await host.provisionScope(staff, { tenantId: t3, scopeId: sibling, jurisdiction: 'eu' });
      await expect(host.getScope(alice, t3, sibling)).resolves.toBeDefined();
      // Unsuspend restores.
      await host.admin.unsuspendScope(staff, t3, s3);
      await expect(host.getScope(alice, t3, s3)).resolves.toBeDefined();
    });

    it('archive then un-archive is an explicit audited restore (§4.2)', async () => {
      await host.admin.archiveScope(staff, t3, s3);
      await expect(host.getScope(alice, t3, s3)).rejects.toThrow(/scope not active/);
      await host.admin.unarchiveScope(staff, t3, s3);
      await expect(host.getScope(alice, t3, s3)).resolves.toBeDefined();

      const transitions = (await host.admin.auditLog(staff, { tenantId: t3 })).filter(
        (r) => r.action === 'archiveScope' || r.action === 'unarchiveScope',
      );
      expect(transitions.map((r) => r.action)).toEqual(
        expect.arrayContaining(['archiveScope', 'unarchiveScope']),
      );
      for (const r of transitions) {
        expect(r.scopeId).toBe(s3);
        expect(r.actor).toBe(staff);
      }
    });

    it('rejects an illegal scope transition, fail closed (§4.2)', async () => {
      // s3 is active — you cannot un-archive an active scope.
      await expect(host.admin.unarchiveScope(staff, t3, s3)).rejects.toThrow(
        /illegal scope transition/,
      );
    });

    it('rejects a lifecycle transition on a scope not under the named tenant', async () => {
      await expect(host.admin.suspendScope(staff, t1, s3)).rejects.toThrow(
        /unknown scope for tenant/,
      );
    });

    // -- entitlement gate (control-plane.md §4.3) -----------------------------

    it('gates a module operation on the tenant holding its SKU flag (§4.3)', async () => {
      host.registerModule(billedMod);
      await host.admin.createTenant(staff, { id: t4, slug: 'billed-co', name: 'Billed Co' });
      await host.provisionScope(staff, { tenantId: t4, scopeId: s4, jurisdiction: 'eu' });
      const stub = await host.getScope(alice, t4, s4);

      // Default-deny: the flag is not held, so the operation does not resolve.
      await expect(stub.invoke('billed/act')).rejects.toThrow(/not entitled/);

      // Granting the flag loads the module for this tenant.
      await host.admin.grantEntitlement(staff, t4, 'billed');
      await expect(stub.invoke<string>('billed/act')).resolves.toBe('ran');
      expect(await host.admin.listEntitlements(staff, t4)).toContain('billed');

      // Revoking it takes the operation away again — as if never registered.
      await host.admin.revokeEntitlement(staff, t4, 'billed');
      await expect(stub.invoke('billed/act')).rejects.toThrow(/not entitled/);
      expect(await host.admin.listEntitlements(staff, t4)).not.toContain('billed');
    });

    it('audits grant/revoke idempotently and records the SKU flag', async () => {
      // Re-grant twice: only the first is a real change, so only one row.
      await host.admin.grantEntitlement(staff, t4, 'audited-sku');
      await host.admin.grantEntitlement(staff, t4, 'audited-sku');
      const grants = (await host.admin.auditLog(staff, { tenantId: t4 })).filter(
        (r) =>
          r.action === 'grantEntitlement' &&
          (r.after as { entitlementKey: string }).entitlementKey === 'audited-sku',
      );
      expect(grants).toHaveLength(1);
      expect(grants[0]!.actor).toBe(staff);

      await host.admin.revokeEntitlement(staff, t4, 'audited-sku');
      const revokes = (await host.admin.auditLog(staff, { tenantId: t4 })).filter(
        (r) => r.action === 'revokeEntitlement',
      );
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

    // -- the scope directory, read side (control-plane.md §3.2/§4.5) ----------
    // §3.2 calls the directory the only complete inventory of tenants and scopes.
    // The write side was always complete; these pin the read side that makes the
    // claim true — and that the console is built on.

    it('defaults an unnamed scope to a slug derived from its id (§3.2)', async () => {
      await host.admin.createTenant(staff, { id: t5, slug: 'directory-co', name: 'Directory Co' });
      const bare = scopeId.parse(ulid());
      await host.provisionScope(staff, { tenantId: t5, scopeId: bare });

      const rec = await host.admin.getScopeRecord(staff, t5, bare);
      // A ULID lowercases into a valid slug, so the placeholder is unique by
      // construction — every pre-existing caller provisions without naming.
      expect(rec).toMatchObject({
        id: bare,
        tenantId: t5,
        slug: bare.toLowerCase(),
        kind: 'scope',
        name: bare.toLowerCase(),
        vertical: null,
        parentScopeId: null,
        status: 'active',
        storageShape: 'A',
      });
    });

    it('round-trips the naming fields supplied at provisioning (§3.2)', async () => {
      const named = scopeId.parse(ulid());
      await host.provisionScope(staff, {
        tenantId: t5,
        scopeId: named,
        slug: 'brf-vasastan',
        kind: 'brf',
        name: 'Brf Vasastan',
        vertical: 'housing',
        jurisdiction: 'eu',
      });
      expect(await host.admin.getScopeRecord(staff, t5, named)).toMatchObject({
        slug: 'brf-vasastan',
        kind: 'brf',
        name: 'Brf Vasastan',
        vertical: 'housing',
        jurisdiction: 'eu',
      });
    });

    it('refuses a slug already taken under the tenant, and re-provision is still idempotent (§3.2)', async () => {
      const other = scopeId.parse(ulid());
      await expect(
        host.provisionScope(staff, { tenantId: t5, scopeId: other, slug: 'brf-vasastan' }),
      ).rejects.toThrow(/already taken/);

      // Idempotency is keyed on the scope id, so re-provisioning the SAME scope
      // must not collide with its own slug.
      const named = (await host.admin.listScopes(staff, { tenantId: t5 })).find(
        (s) => s.slug === 'brf-vasastan',
      )!;
      await expect(
        host.provisionScope(staff, { tenantId: t5, scopeId: named.id, slug: 'brf-vasastan' }),
      ).resolves.toBeUndefined();
    });

    it('scopes slug uniqueness to the tenant, not the fleet (§3.2)', async () => {
      // The same slug under a different tenant is legitimate: the console's
      // handle is {tenant.slug}/{scope.slug}, which stays unique either way.
      const elsewhere = scopeId.parse(ulid());
      await expect(
        host.provisionScope(staff, { tenantId: t3, scopeId: elsewhere, slug: 'brf-vasastan' }),
      ).resolves.toBeUndefined();
    });

    it('refuses a tenant slug already taken, fail closed (§4.1)', async () => {
      // INSERT OR IGNORE would have reported this as an idempotent no-op and
      // silently not created the tenant the caller asked for.
      await expect(
        host.admin.createTenant(staff, {
          id: tenantId.parse(ulid()),
          slug: 'directory-co',
          name: 'Impostor Co',
        }),
      ).rejects.toThrow(/already taken/);
    });

    it('enumerates the scopes under a tenant, and filters by status (§4.5)', async () => {
      const all = await host.admin.listScopes(staff, { tenantId: t5 });
      expect(all.length).toBeGreaterThanOrEqual(2);
      expect(all.every((s) => s.tenantId === t5)).toBe(true);
      // Ordered by scope id — ULID order is chronological.
      expect(all.map((s) => s.id)).toEqual([...all.map((s) => s.id)].sort());

      const target = all[0]!;
      await host.admin.suspendScope(staff, t5, target.id);

      const suspended = await host.admin.listScopes(staff, { tenantId: t5, status: 'suspended' });
      expect(suspended.map((s) => s.id)).toEqual([target.id]);

      // Several statuses at once — the console's All / Suspended / Archived tabs.
      const both = await host.admin.listScopes(staff, {
        tenantId: t5,
        status: ['active', 'suspended'],
      });
      expect(both.length).toBe(all.length);

      // An empty status list means "no status is acceptable" — it must match
      // nothing, never degenerate into an unfiltered read of the whole fleet.
      expect(await host.admin.listScopes(staff, { tenantId: t5, status: [] })).toEqual([]);

      await host.admin.unsuspendScope(staff, t5, target.id);
    });

    it('lists the whole fleet across tenants when unfiltered (§4.5)', async () => {
      const fleet = await host.admin.listScopes(staff);
      const tenants = new Set(fleet.map((s) => s.tenantId));
      expect(tenants.size).toBeGreaterThan(1);
      expect(fleet.length).toBeGreaterThanOrEqual(
        (await host.admin.listScopes(staff, { tenantId: t5 })).length,
      );
    });

    it('filters the fleet by vertical (§4.5)', async () => {
      const housing = await host.admin.listScopes(staff, { vertical: 'housing' });
      expect(housing.length).toBeGreaterThanOrEqual(1);
      expect(housing.every((s) => s.vertical === 'housing')).toBe(true);
    });

    it('fails closed reading a scope record on a mismatched pair (K-3)', async () => {
      const [any] = await host.admin.listScopes(staff, { tenantId: t5 });
      // The scope exists — but not under t1. It must read as absent, never as
      // itself: the same rule getScope applies when minting a stub.
      expect(await host.admin.getScopeRecord(staff, t1, any!.id)).toBeUndefined();
      expect(await host.admin.getScopeRecord(staff, t5, scopeId.parse(ulid()))).toBeUndefined();
    });

    it('projects the applied-migration count into the directory (§5.4)', async () => {
      // schema_version shipped as a column and was written by nothing — always
      // '0'. Registered modules carry migrations, so a provisioned scope must
      // report a count, which is what makes "which scopes are behind" answerable
      // from the index without fanning out.
      const [any] = await host.admin.listScopes(staff, { tenantId: t5 });
      expect(Number(any!.schemaVersion)).toBeGreaterThan(0);
    });

    it('stamps the audit target with the scope vertical for lifecycle actions (§4.4)', async () => {
      // `vertical` was plumbed end-to-end and passed by no call site — every row
      // was null. A lifecycle action on a scope that names one must carry it.
      const named = (await host.admin.listScopes(staff, { tenantId: t5 })).find(
        (s) => s.vertical === 'housing',
      )!;
      await host.admin.suspendScope(staff, t5, named.id);
      const rows = (await host.admin.auditLog(staff, { tenantId: t5, scopeId: named.id })).filter(
        (r) => r.action === 'suspendScope',
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.vertical).toBe('housing');
      await host.admin.unsuspendScope(staff, t5, named.id);
    });

    // -- the admin audit log, read side (control-plane.md §4.4/§4.5) ----------

    it('narrows the audit log by scope, actor and action (§4.5)', async () => {
      const [any] = await host.admin.listScopes(staff, { tenantId: t5 });

      const byScope = await host.admin.auditLog(staff, { tenantId: t5, scopeId: any!.id });
      expect(byScope.length).toBeGreaterThan(0);
      expect(byScope.every((r) => r.scopeId === any!.id)).toBe(true);

      const byActor = await host.admin.auditLog(staff, { tenantId: t5, actor: staff });
      expect(byActor.length).toBeGreaterThan(0);
      expect(byActor.every((r) => r.actor === staff)).toBe(true);
      // A different actor shares the log and must not see these rows.
      expect(await host.admin.auditLog(staff, { actor: platformActorId.parse(ulid()) })).toEqual([]);

      const lifecycle = await host.admin.auditLog(staff, {
        tenantId: t5,
        action: ['suspendScope', 'unsuspendScope'],
      });
      expect(lifecycle.length).toBeGreaterThan(0);
      expect(
        lifecycle.every((r) => r.action === 'suspendScope' || r.action === 'unsuspendScope'),
      ).toBe(true);

      // Single action, not an array — both spellings are accepted.
      const provisions = await host.admin.auditLog(staff, { tenantId: t5, action: 'provisionScope' });
      expect(provisions.every((r) => r.action === 'provisionScope')).toBe(true);

      // Empty action list matches nothing rather than everything.
      expect(await host.admin.auditLog(staff, { tenantId: t5, action: [] })).toEqual([]);
    });

    it('orders oldest-first by default and newest-first on request (§4.5)', async () => {
      const asc = await host.admin.auditLog(staff, { tenantId: t5 });
      const desc = await host.admin.auditLog(staff, { tenantId: t5, order: 'desc' });
      expect(asc.length).toBe(desc.length);
      expect(asc.length).toBeGreaterThan(1);
      // The default preserves the ordering the log shipped with; the console reads desc.
      expect(desc.map((r) => r.id)).toEqual([...asc.map((r) => r.id)].reverse());
    });

    it('limits and pages the audit log by cursor (§4.5)', async () => {
      const all = await host.admin.auditLog(staff, { tenantId: t5 });
      expect(all.length).toBeGreaterThan(2);

      const first = await host.admin.auditLog(staff, { tenantId: t5, limit: 2 });
      expect(first.map((r) => r.id)).toEqual(all.slice(0, 2).map((r) => r.id));

      // The cursor IS the last entry's id — ULID order is chronological, so no
      // separate encoding is needed. Paging forward resumes strictly after it.
      const next = await host.admin.auditLog(staff, {
        tenantId: t5,
        limit: 2,
        cursor: first[first.length - 1]!.id,
      });
      expect(next.map((r) => r.id)).toEqual(all.slice(2, 4).map((r) => r.id));

      // Descending pages backward from the cursor.
      const descPage = await host.admin.auditLog(staff, {
        tenantId: t5,
        order: 'desc',
        limit: 2,
        cursor: all[all.length - 1]!.id,
      });
      expect(descPage.map((r) => r.id)).toEqual(
        all
          .slice(-3, -1)
          .map((r) => r.id)
          .reverse(),
      );
    });

    it('bounds the audit log by time (§4.5)', async () => {
      const all = await host.admin.auditLog(staff, { tenantId: t5 });
      const pivot = all[1]!.at;
      // `since` is inclusive, `until` exclusive.
      const since = await host.admin.auditLog(staff, { tenantId: t5, since: pivot });
      expect(since.every((r) => r.at >= pivot)).toBe(true);
      expect(since.some((r) => r.id === all[1]!.id)).toBe(true);

      const until = await host.admin.auditLog(staff, { tenantId: t5, until: pivot });
      expect(until.every((r) => r.at < pivot)).toBe(true);
    });
  });
}
