import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  moduleManifest,
  permissionKey,
  principalId,
  scopeId,
  tenantId,
  type EntityRef,
  type PermissionKey,
  type PrincipalId,
} from '@substrat-run/contracts';
import { ulid, type OperationHandler, type ScopeHost } from '@substrat-run/kernel';
import type { ScopeHostFixture } from './scope-host-suite.js';

const permModManifest = moduleManifest.parse({
  id: '@perm/mod',
  version: '1.0.0',
  kernelContract: '^0.0.1',
  permissions: [
    { key: 'perm:use', description: 'use the thing' },
    { key: 'perm:read', description: 'read the thing' },
  ],
  events: { emits: [], consumes: [] },
  migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
  attachmentTargets: [],
  entityRelations: [{ entityType: 'item', parentType: 'box' }],
  entitlementKey: 'perm',
});

const linkOp: OperationHandler<{ child: EntityRef; parent: EntityRef }, void> = (ctx, input) => {
  ctx.link(input.child, input.parent);
};

const probeOp: OperationHandler<{ permission: PermissionKey; entity?: EntityRef }, unknown> = (
  ctx,
  input,
) => ctx.check(input.permission, input.entity);

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
      host.registerModule({
        manifest: permModManifest,
        operations: { 'perm/link': linkOp, 'perm/probe': probeOp },
      });
      await host.provisionScope({ tenantId: t1, scopeId: s1 });
      await host.provisionScope({ tenantId: t1, scopeId: s2 });

      host.admin.defineRole(t1, {
        key: 'admin',
        permissions: [PERM_USE, PERM_READ],
        source: 'vertical',
      });
      host.admin.defineRole(t1, { key: 'tech', permissions: [PERM_READ], source: 'vertical' });
      host.admin.assignRole({ principalId: alice, roleKey: 'admin', node: { tenantId: t1, scopeId: null } });
      host.admin.assignRole({ principalId: bob, roleKey: 'tech', node: { tenantId: t1, scopeId: s1 } });

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

      host.admin.grant({
        principalId: carol,
        permission: PERM_READ,
        node: { tenantId: t1, scopeId: s1 },
        entity: { entityType: 'box', entityId: 'b1' },
        grantedBy: alice,
      });
      host.admin.grant({
        principalId: dave,
        permission: PERM_READ,
        node: { tenantId: t1, scopeId: s1 },
        expiresAt: (await import('@substrat-run/contracts')).instant.parse('2000-01-01T00:00:00Z'),
        grantedBy: alice,
      });
      host.admin.grantToOrg('acme', PERM_READ, { tenantId: t1, scopeId: s1 });
      host.admin.addMember(t1, erin, 'acme');
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
  });
}
