import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  permissionKey,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  type EntityRef,
  type PermissionKey,
  type PrincipalId,
} from '@substrat-run/contracts';
import { ulid, type ScopeHost } from '@substrat-run/kernel';
import type { ScopeHostFixture } from './scope-host-suite.js';
import { permMod } from './modules.js';

const PERM_USE = permissionKey.parse('perm:use');
const PERM_READ = permissionKey.parse('perm:read');

/**
 * Contract suite for the default (tuple) permission checker (design doc §4.2,
 * D-23). The fixture host must use the adapter's DEFAULT checker — no
 * UNSAFE_allowAllChecker.
 */
export function permissionContractSuite(
  adapterName: string,
  makeFixture: () => Promise<ScopeHostFixture>,
): void {
  describe(`permission contract (tuple checker): ${adapterName}`, () => {
    let fixture: ScopeHostFixture;
    let host: ScopeHost;
    const t1 = tenantId.parse(ulid());
    const s1 = scopeId.parse(ulid());
    const s2 = scopeId.parse(ulid()); // same tenant, second scope
    const alice: PrincipalId = principalId.parse(ulid()); // tenant-level admin
    const bob: PrincipalId = principalId.parse(ulid()); // scope role at s1 only
    const carol: PrincipalId = principalId.parse(ulid()); // entity-narrowed grant
    const dave: PrincipalId = principalId.parse(ulid()); // expired grant
    const erin: PrincipalId = principalId.parse(ulid()); // via org membership
    const staff = platformActorId.parse(ulid()); // control-plane dev actor (§6)

    const probe = async (
      who: PrincipalId,
      scope: typeof s1,
      permission: PermissionKey,
      entity?: EntityRef,
    ) => {
      const stub = await host.getScope(who, t1, scope);
      return stub.invoke<{ allowed: boolean; proof?: unknown[] }>('perm/probe', {
        permission,
        entity,
      });
    };

    beforeAll(async () => {
      fixture = await makeFixture();
      host = fixture.host;
      host.registerModule(permMod);
      await host.admin.createTenant(staff, { id: t1, slug: 'perm-tenant', name: 'Perm Tenant' });
      await host.admin.grantEntitlement(staff, t1, 'perm'); // default-deny (§4.3): perm/* needs it
      await host.provisionScope(staff, { tenantId: t1, scopeId: s1 });
      await host.provisionScope(staff, { tenantId: t1, scopeId: s2 });

      await host.admin.defineRole(staff, t1, {
        key: 'admin',
        permissions: [PERM_USE, PERM_READ],
        source: 'vertical',
      });
      await host.admin.defineRole(staff, t1, { key: 'tech', permissions: [PERM_READ], source: 'vertical' });
      await host.admin.assignRole(staff, { principalId: alice, roleKey: 'admin', node: { tenantId: t1, scopeId: null } });
      await host.admin.assignRole(staff, { principalId: bob, roleKey: 'tech', node: { tenantId: t1, scopeId: s1 } });

      // Entity graph in s1: item i1 → box b1, item i2 → box b2.
      const stub = await host.getScope(alice, t1, s1);
      await stub.invoke('perm/link', {
        child: { entityType: 'item', entityId: 'i1' },
        parent: { entityType: 'box', entityId: 'b1' },
      });
      await stub.invoke('perm/link', {
        child: { entityType: 'item', entityId: 'i2' },
        parent: { entityType: 'box', entityId: 'b2' },
      });

      await host.admin.grant(staff, {
        principalId: carol,
        permission: PERM_READ,
        node: { tenantId: t1, scopeId: s1 },
        entity: { entityType: 'box', entityId: 'b1' },
        grantedBy: alice,
      });
      await host.admin.grant(staff, {
        principalId: dave,
        permission: PERM_READ,
        node: { tenantId: t1, scopeId: s1 },
        expiresAt: (await import('@substrat-run/contracts')).instant.parse('2000-01-01T00:00:00Z'),
        grantedBy: alice,
      });
      await host.admin.grantToOrg(staff, 'acme', PERM_READ, { tenantId: t1, scopeId: s1 });
      await host.admin.addMember(staff, t1, erin, 'acme');
    });

    afterAll(async () => {
      await fixture.cleanup();
    });

    it('denies by default with the checked permission and node', async () => {
      const d = await probe(principalId.parse(ulid()), s1, PERM_READ);
      expect(d.allowed).toBe(false);
    });

    it('tenant-level roles inherit downward into scopes (rule 2), with proof', async () => {
      const d = await probe(alice, s1, PERM_USE);
      expect(d.allowed).toBe(true);
      expect(d.proof!.length).toBeGreaterThanOrEqual(2);
    });

    it('scope roles are confined to their scope — no sideways leakage', async () => {
      await expect(probe(bob, s1, PERM_READ)).resolves.toMatchObject({ allowed: true });
      await expect(probe(bob, s2, PERM_READ)).resolves.toMatchObject({ allowed: false });
    });

    it('entity-narrowed grants resolve through declared parent edges (rule 3)', async () => {
      const own = await probe(carol, s1, PERM_READ, { entityType: 'item', entityId: 'i1' });
      expect(own.allowed).toBe(true);
      // proof contains the parent tuple AND the grant — the walk shown
      expect(JSON.stringify(own.proof)).toContain('"item:i1"');
      expect(JSON.stringify(own.proof)).toContain('"box:b1"');

      const other = await probe(carol, s1, PERM_READ, { entityType: 'item', entityId: 'i2' });
      expect(other.allowed).toBe(false);

      // No node-level access: the narrow grant does not widen.
      await expect(probe(carol, s1, PERM_READ)).resolves.toMatchObject({ allowed: false });
    });

    it('expired grants are dead', async () => {
      await expect(probe(dave, s1, PERM_READ)).resolves.toMatchObject({ allowed: false });
    });

    it('org membership reaches org grants (rule 4), membership tuple in the proof', async () => {
      const d = await probe(erin, s1, PERM_READ);
      expect(d.allowed).toBe(true);
      expect(JSON.stringify(d.proof)).toContain('org:acme');
    });

    // -- control-plane audit trail (control-plane.md §4.4) --------------------

    it('records every admin mutation with actor and target, append-only (K-20)', async () => {
      const log = await host.admin.auditLog({ tenantId: t1 });
      // The six seed mutations each left a row; nothing is ever removed.
      expect(log.length).toBeGreaterThanOrEqual(6);
      // Every row is stamped platform-side: our staff actor, this tenant, a timestamp.
      for (const row of log) {
        expect(row.actor).toBe(staff);
        expect(row.tenantId).toBe(t1);
        expect(typeof row.at).toBe('string');
      }
      const actions = log.map((r) => r.action);
      expect(actions).toEqual(
        expect.arrayContaining(['defineRole', 'assignRole', 'grant', 'grantToOrg', 'addMember']),
      );
      // defineRole captures the applied role in `after` — the raw material for
      // the §4.5 permission diff.
      const defined = log.find((r) => r.action === 'defineRole');
      expect(defined?.after).toMatchObject({ permissions: expect.any(Array) });
    });

    it('captures before/after when a role is redefined — the permission-diff seed', async () => {
      await host.admin.defineRole(staff, t1, { key: 'tech', permissions: [PERM_USE], source: 'vertical' });
      const redefines = (await host.admin.auditLog({ tenantId: t1 }))
        .filter(
          (r) =>
            r.action === 'defineRole' &&
            (r.after as { key?: string })?.key === 'tech' &&
            r.before !== null,
        );
      expect(redefines.length).toBeGreaterThanOrEqual(1);
      const last = redefines[redefines.length - 1]!;
      expect((last.before as { permissions: string[] }).permissions).toEqual([PERM_READ]);
      expect((last.after as { permissions: string[] }).permissions).toEqual([PERM_USE]);
    });

    it('scopes the audit read by tenant', async () => {
      const otherTenant = tenantId.parse(ulid());
      expect(await host.admin.auditLog({ tenantId: otherTenant })).toEqual([]);
    });
  });
}
