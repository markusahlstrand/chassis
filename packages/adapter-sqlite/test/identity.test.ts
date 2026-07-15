import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { SqliteScopeHost } from '../src/index.js';

/**
 * The control-plane identity seam (D-16). An auth adapter at the edge maps an
 * external identity (provider + externalId) to a Substrat principal + home node;
 * the kernel stays provider-neutral. Authentication input only.
 */
describe('control-plane identity mapping', () => {
  let dir: string;
  let host: SqliteScopeHost;
  const staff = platformActorId.parse(ulid());
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());
  const elin = principalId.parse(ulid());

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-identity-'));
    host = new SqliteScopeHost({ dir });
  });
  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('links an external identity and resolves it to the principal + home node', async () => {
    await host.admin.linkIdentity(staff, {
      provider: 'better-auth',
      externalId: 'ba-user-123',
      principal: elin,
      tenantId: t,
      scopeId: s,
    });
    expect(await host.admin.resolveIdentity('better-auth', 'ba-user-123')).toEqual({
      principal: elin,
      tenantId: t,
      scopeId: s,
    });
  });

  it('resolves an unknown identity to undefined', async () => {
    expect(await host.admin.resolveIdentity('better-auth', 'nope')).toBeUndefined();
  });

  it('is idempotent on (provider, externalId) — re-linking is a no-op, not audited twice', async () => {
    await host.admin.linkIdentity(staff, {
      provider: 'better-auth',
      externalId: 'ba-user-123',
      principal: elin,
      tenantId: t,
      scopeId: s,
    });
    const links = (await host.admin.auditLog({ tenantId: t })).filter(
      (e) => e.action === 'linkIdentity',
    );
    expect(links).toHaveLength(1);
    expect(links[0]!.actor).toBe(staff);
  });

  it('keys by provider — the same externalId under a different provider is distinct', async () => {
    const otto = principalId.parse(ulid());
    await host.admin.linkIdentity(staff, {
      provider: 'oidc:https://authhero.example',
      externalId: 'ba-user-123', // same string, different provider
      principal: otto,
      tenantId: t,
      scopeId: s,
    });
    expect(
      (await host.admin.resolveIdentity('oidc:https://authhero.example', 'ba-user-123'))?.principal,
    ).toBe(otto);
    expect((await host.admin.resolveIdentity('better-auth', 'ba-user-123'))?.principal).toBe(elin);
  });

  it('supports a tenant-level home (no scope) — resolves scopeId to null', async () => {
    const staffUser = principalId.parse(ulid());
    await host.admin.linkIdentity(staff, {
      provider: 'better-auth',
      externalId: 'ba-admin-1',
      principal: staffUser,
      tenantId: t,
    });
    expect(await host.admin.resolveIdentity('better-auth', 'ba-admin-1')).toEqual({
      principal: staffUser,
      tenantId: t,
      scopeId: null,
    });
  });

  it('persists across a reopen of the directory', async () => {
    await host.close();
    host = new SqliteScopeHost({ dir });
    expect((await host.admin.resolveIdentity('better-auth', 'ba-user-123'))?.principal).toBe(elin);
  });
});
