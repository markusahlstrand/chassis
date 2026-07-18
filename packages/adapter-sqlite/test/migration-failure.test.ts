import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid, UNSAFE_allowAllChecker } from '@substrat-run/kernel';
import { brokenMod } from '@substrat-run/contract-tests';
import { SqliteScopeHost } from '../src/index.js';

/**
 * A failed migration must leave a record (#32). kernel-design §5.3: failure is
 * per-scope and fails closed — one scope down, not the fleet. Before this, the
 * directory learned nothing from that: `schema_version` was projected only on the
 * success path, so a half-migrated scope kept a stale value and rendered `active`.
 *
 * Its own host: the broken module would fail every scope in a shared fixture.
 */
describe('migration failure is recorded in the directory', () => {
  let dir: string;
  let host: SqliteScopeHost;
  const staff = platformActorId.parse(ulid());
  const alice = principalId.parse(ulid());
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-migfail-'));
    host = new SqliteScopeHost({ dir, checker: UNSAFE_allowAllChecker });
    host.registerModule(brokenMod);
    await host.admin.createTenant(staff, { id: t, slug: `t-${t.toLowerCase()}`, name: 'T' });
    // Entitlements are default-deny (§4.3): without the grant the module never
    // loads, its migration never runs, and this suite would pass vacuously.
    await host.admin.grantEntitlement(staff, t, 'broken');
    // Provisioning applies migrations eagerly, so this is the first failed
    // attempt — expected, and swallowed so the suite can assert on what it left
    // behind. (The scope row exists; it is the migration that failed.)
    await expect(
      host.provisionScope(staff, { tenantId: t, scopeId: s, jurisdiction: 'eu' }),
    ).rejects.toThrow(/scope fails closed/);
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('fails the scope closed rather than serving a half-migrated schema', async () => {
    await expect(host.getScope(alice, t, s)).rejects.toThrow(/scope fails closed/);
  });

  it('records which module@version failed, and why', async () => {
    await expect(host.getScope(alice, t, s)).rejects.toThrow();
    const record = await host.admin.getScopeRecord(t, s);
    expect(record?.migrationFailure).not.toBeNull();
    expect(record?.migrationFailure?.version).toBe('@test/broken@0002-broken');
    expect(record?.migrationFailure?.error).toMatch(/./);
    expect(record?.migrationFailure?.lastAttemptAt).toMatch(/^\d{4}-/);
  });

  it('projects the count that actually landed, not the pre-attempt value', async () => {
    // `0001-ok` applied and journaled; `0002-broken` rolled back. A stale '0'
    // here is the exact symptom #32 describes — the scope looking untouched.
    const record = await host.admin.getScopeRecord(t, s);
    expect(record?.schemaVersion).toBe('1');
  });

  it('counts consecutive attempts, so a sweep can back off (#49)', async () => {
    const before = (await host.admin.getScopeRecord(t, s))?.migrationFailure?.attempts ?? 0;
    await expect(host.getScope(alice, t, s)).rejects.toThrow();
    const after = (await host.admin.getScopeRecord(t, s))?.migrationFailure?.attempts ?? 0;
    expect(after).toBeGreaterThan(before);
  });

  it('leaves a healthy scope with no failure record', async () => {
    const ok = scopeId.parse(ulid());
    const healthyDir = mkdtempSync(join(tmpdir(), 'substrat-migok-'));
    const healthy = new SqliteScopeHost({ dir: healthyDir, checker: UNSAFE_allowAllChecker });
    try {
      await healthy.admin.createTenant(staff, { id: t, slug: `t-${t.toLowerCase()}`, name: 'T' });
      await healthy.provisionScope(staff, { tenantId: t, scopeId: ok, jurisdiction: 'eu' });
      await healthy.getScope(alice, t, ok);
      const record = await healthy.admin.getScopeRecord(t, ok);
      expect(record?.migrationFailure).toBeNull();
    } finally {
      await healthy.close();
      rmSync(healthyDir, { recursive: true, force: true });
    }
  });
});
