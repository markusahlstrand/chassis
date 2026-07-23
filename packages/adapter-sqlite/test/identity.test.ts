import { mkdtempSync, rmSync } from 'node:fs';
import Database from 'better-sqlite3';
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

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-identity-'));
    host = new SqliteScopeHost({ dir });
    // K-23: a pool declares its topology before it may link. Both providers here
    // serve this one tenant, so both are tenant-bound.
    for (const provider of ['better-auth', 'oidc:https://authhero.example']) {
      await host.admin.registerIdentityPool(staff, { provider, topology: 'tenant-bound', tenantId: t });
    }
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
    expect(await host.admin.resolveIdentity(t, 'better-auth', 'ba-user-123')).toEqual({
      principal: elin,
      scopeId: s,
    });
  });

  it('resolves an unknown identity to undefined', async () => {
    expect(await host.admin.resolveIdentity(t, 'better-auth', 'nope')).toBeUndefined();
  });

  it('is idempotent on (tenantId, provider, externalId) — re-linking is a no-op, not audited twice', async () => {
    await host.admin.linkIdentity(staff, {
      provider: 'better-auth',
      externalId: 'ba-user-123',
      principal: elin,
      tenantId: t,
      scopeId: s,
    });
    const links = (await host.admin.auditLog(staff, { tenantId: t })).filter(
      (e) => e.action === 'linkIdentity',
    );
    expect(links).toHaveLength(1);
    expect(links[0]!.actor).toBe(staff);
  });

  it('unlinks a principal — resolve stops returning it, is idempotent, and the key frees for re-link', async () => {
    const frank = principalId.parse(ulid());
    await host.admin.linkIdentity(staff, { provider: 'better-auth', externalId: 'ba-frank', principal: frank, tenantId: t, scopeId: s });
    expect(await host.admin.resolveIdentity(t, 'better-auth', 'ba-frank')).toEqual({ principal: frank, scopeId: s });

    await host.admin.unlinkIdentity(staff, t, frank);
    expect(await host.admin.resolveIdentity(t, 'better-auth', 'ba-frank')).toBeUndefined();

    // Idempotent: unlinking a principal with no link is a silent no-op.
    await host.admin.unlinkIdentity(staff, t, frank);

    // A DELETE, not a tombstone — the key is free, so a re-invite re-links a fresh principal.
    const frank2 = principalId.parse(ulid());
    await host.admin.linkIdentity(staff, { provider: 'better-auth', externalId: 'ba-frank', principal: frank2, tenantId: t, scopeId: s });
    expect(await host.admin.resolveIdentity(t, 'better-auth', 'ba-frank')).toEqual({ principal: frank2, scopeId: s });
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
      (await host.admin.resolveIdentity(t, 'oidc:https://authhero.example', 'ba-user-123'))?.principal,
    ).toBe(otto);
    expect((await host.admin.resolveIdentity(t, 'better-auth', 'ba-user-123'))?.principal).toBe(elin);
  });

  it('supports a tenant-level home (no scope) — resolves scopeId to null', async () => {
    const staffUser = principalId.parse(ulid());
    await host.admin.linkIdentity(staff, {
      provider: 'better-auth',
      externalId: 'ba-admin-1',
      principal: staffUser,
      tenantId: t,
    });
    expect(await host.admin.resolveIdentity(t, 'better-auth', 'ba-admin-1')).toEqual({
      principal: staffUser,
      scopeId: null,
    });
  });

  it('persists across a reopen of the directory', async () => {
    await host.close();
    host = new SqliteScopeHost({ dir });
    expect((await host.admin.resolveIdentity(t, 'better-auth', 'ba-user-123'))?.principal).toBe(elin);
  });
});

/**
 * The pre-K-22 directory carried `PRIMARY KEY (provider, external_id)`. A PK cannot be
 * ALTERed, so opening such a directory rebuilds the table. This is the half the shared
 * contract suite cannot reach — it only ever sees freshly created stores.
 */
describe('identity key migration from the pre-K-22 shape', () => {
  let dir: string;
  const staff = platformActorId.parse(ulid());
  const t = tenantId.parse(ulid());
  const legacy = principalId.parse(ulid());

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-idmigrate-'));
    // Hand-build a directory in the OLD shape, with a row in it.
    const db = new Database(join(dir, '_directory.sqlite'));
    db.exec(`
      CREATE TABLE _substrat_identities (
        provider     TEXT NOT NULL,
        external_id  TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        tenant_id    TEXT NOT NULL,
        scope_id     TEXT,
        created_at   TEXT NOT NULL,
        PRIMARY KEY (provider, external_id)
      );
    `);
    db.prepare(
      `INSERT INTO _substrat_identities
         (provider, external_id, principal_id, tenant_id, scope_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('oidc:legacy', 'user-1', legacy, t, null, new Date().toISOString());
    db.close();
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('rebuilds the table and preserves existing rows', async () => {
    const host = new SqliteScopeHost({ dir });
    try {
      await host.admin.createTenant(staff, { id: t, slug: `t-${t.toLowerCase()}`, name: 'T' });
      await host.admin.registerIdentityPool(staff, {
        provider: 'oidc:legacy',
        topology: 'central',
        tenantId: null,
      });
      // The pre-existing binding still resolves — the copy is lossless.
      expect((await host.admin.resolveIdentity(t, 'oidc:legacy', 'user-1'))?.principal).toBe(legacy);

      // And the key is now tenant-scoped: a second tenant may reuse the same
      // externalId, which the old PK made impossible.
      const other = tenantId.parse(ulid());
      const otherPrincipal = principalId.parse(ulid());
      await host.admin.createTenant(staff, {
        id: other,
        slug: `o-${other.toLowerCase()}`,
        name: 'O',
      });
      await host.admin.linkIdentity(staff, {
        provider: 'oidc:legacy',
        externalId: 'user-1',
        principal: otherPrincipal,
        tenantId: other,
      });
      expect((await host.admin.resolveIdentity(other, 'oidc:legacy', 'user-1'))?.principal).toBe(
        otherPrincipal,
      );
      expect((await host.admin.resolveIdentity(t, 'oidc:legacy', 'user-1'))?.principal).toBe(legacy);
    } finally {
      await host.close();
    }
  });

  it('is a no-op on a directory already in the new shape', async () => {
    const host = new SqliteScopeHost({ dir });
    try {
      expect((await host.admin.resolveIdentity(t, 'oidc:legacy', 'user-1'))?.principal).toBe(legacy);
    } finally {
      await host.close();
    }
  });
});
