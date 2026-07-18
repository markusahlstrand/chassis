import { env } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid, UNSAFE_allowAllChecker } from '@substrat-run/kernel';
import { permissionContractSuite, scopeHostContractSuite } from '@substrat-run/contract-tests';
import { CloudflareScopeHost } from '../src/host.js';

// The scope-host suite runs against an allow-all checker (it exercises no
// ctx.check). Runtime module registration is unsupported on CF — the ScopeDO
// closes over a code-time module set — so that one late-registration test is
// skipped; every other test is shared unchanged (D-14).
scopeHostContractSuite(
  'adapter-cloudflare',
  async () => {
    const host = new CloudflareScopeHost({
      scope: env.SCOPE,
      controlPlane: env.CONTROL_PLANE,
      checker: UNSAFE_allowAllChecker,
    });
    return { host, cleanup: async () => host.close() };
  },
  { supportsRuntimeRegistration: false },
);

// The permission suite runs against the DO's default tuple checker (scope tuples
// in the ScopeDO, tenant tuples + roles in the ControlPlaneDO).
permissionContractSuite('adapter-cloudflare', async () => {
  const host = new CloudflareScopeHost({ scope: env.SCOPE, controlPlane: env.CONTROL_PLANE });
  return { host, cleanup: async () => host.close() };
});

/**
 * The Cloudflare half of #32 — the same guarantee the pure adapter asserts, on the
 * adapter that is actually deployed. It matters more here: the projection is done
 * by the COORDINATOR after the ScopeDO reports, so a rejected `migrate()` used to
 * skip the write entirely and leave the scope rendering as healthy.
 *
 * Points at BROKEN_SCOPE (worker.ts) — a DO class carrying only the module whose
 * migration cannot apply, since a DO closes over a code-time module set.
 *
 * Lives in THIS file rather than its own: the pool runs `singleWorker` with
 * `isolatedStorage: false`, and a second test file re-evaluates the worker mid-run,
 * which invalidates every live DO ("worker.ts changed").
 */
describe('migration failure is recorded in the directory', () => {
  let host: CloudflareScopeHost;
  const staff = platformActorId.parse(ulid());
  const alice = principalId.parse(ulid());
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());

  beforeAll(async () => {
    host = new CloudflareScopeHost({
      scope: env.BROKEN_SCOPE,
      controlPlane: env.CONTROL_PLANE,
      checker: UNSAFE_allowAllChecker,
    });
    await host.admin.createTenant(staff, { id: t, slug: `t-${t.toLowerCase()}`, name: 'T' });
    // Default-deny (§4.3): without the grant the module never loads and its
    // migration never runs, so this suite would pass vacuously.
    await host.admin.grantEntitlement(staff, t, 'broken');
    await expect(
      host.provisionScope(staff, { tenantId: t, scopeId: s, jurisdiction: 'eu' }),
    ).rejects.toThrow(/scope fails closed/);
  });

  afterAll(async () => {
    await host.close();
  });

  it('fails the scope closed rather than serving a half-migrated schema', async () => {
    await expect(host.getScope(alice, t, s)).rejects.toThrow(/scope fails closed/);
  });

  it('records which module@version failed, through the coordinator', async () => {
    const record = await host.admin.getScopeRecord(t, s);
    expect(record?.migrationFailure).not.toBeNull();
    expect(record?.migrationFailure?.version).toBe('@test/broken@0002-broken');
    expect(record?.migrationFailure?.attempts).toBeGreaterThan(0);
  });

  it('projects the count that actually landed, not the pre-attempt value', async () => {
    const record = await host.admin.getScopeRecord(t, s);
    expect(record?.schemaVersion).toBe('1');
  });
});
