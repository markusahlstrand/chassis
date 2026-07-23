import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { orgId, platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { MODULES, provisionDashboard, type DashboardNode } from '../src/index.js';
import type { DashboardMemberRow } from '../src/module.js';

/**
 * Phase 3 — team membership. An invite composes the invites engine (hashed,
 * accept-required); accepting flips the roster projection to active and (in the
 * worker) becomes a kernel role assignment. This test drives the module layer: the
 * §5.1 bound at invite time, the hash gate at accept time, and the roster.
 */
describe('Dashboard teams — invite + accept', () => {
  let dir: string;
  let host: SqliteScopeHost;
  let staff = platformActorId.parse(ulid());

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-members-'));
    host = new SqliteScopeHost({ dir });
    for (const m of MODULES) host.registerModule(m);
    staff = platformActorId.parse(ulid());
  });

  afterEach(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const PROVIDER = 'authhero';

  /** Bootstrap a team the way the worker's createTeam does: provision + org + init. */
  const makeTeam = async (slug: string, ownerEmail: string): Promise<DashboardNode> => {
    await host.admin.registerIdentityPool(staff, { provider: PROVIDER, topology: 'central', tenantId: null });
    const node = await provisionDashboard(host, {
      tenantId: tenantId.parse(ulid()),
      scopeId: scopeId.parse(ulid()),
      owner: principalId.parse(ulid()),
      slug,
      name: slug,
    });
    const org = orgId.parse(ulid());
    await host.admin.createOrg(staff, { id: org, tenantId: node.tenantId, slug: 'team', name: slug });
    const scope = await host.getScope(node.principal, node.tenantId, node.scopeId);
    await scope.invoke('dashboard/init-team', { orgId: org, ownerEmail });
    return node;
  };

  const members = async (node: DashboardNode): Promise<DashboardMemberRow[]> => {
    const scope = await host.getScope(node.principal, node.tenantId, node.scopeId);
    return scope.invoke<DashboardMemberRow[]>('dashboard/list-members', {});
  };

  it('owner invites, recipient accepts with the matching email, and the roster reflects it', async () => {
    const acme = await makeTeam('acme', 'owner@acme.com');
    const ownerScope = await host.getScope(acme.principal, acme.tenantId, acme.scopeId);

    // Owner seeded as the first active member.
    let roster = await members(acme);
    expect(roster).toHaveLength(1);
    expect(roster[0]).toMatchObject({ email: 'owner@acme.com', role_key: 'owner', status: 'active' });

    // Invite at 'member' → a pending roster row + an invitation.
    const { invitationId } = await ownerScope.invoke<{ invitationId: string }>('dashboard/invite-member', {
      email: 'jane@acme.com',
      roleKey: 'member',
    });
    roster = await members(acme);
    expect(roster.find((m) => m.email === 'jane@acme.com')).toMatchObject({ status: 'invited', role_key: 'member', principal: null });

    // Accept as a freshly-minted recipient principal, presenting the matching email.
    const jane = principalId.parse(ulid());
    const janeScope = await host.getScope(jane, acme.tenantId, acme.scopeId);
    const res = await janeScope.invoke<{ roleKey: string }>('dashboard/accept-invite', {
      invitationId,
      identifier: 'jane@acme.com',
    });
    expect(res.roleKey).toBe('member');

    // The roster row is now active and bound to Jane's principal.
    roster = await members(acme);
    expect(roster.find((m) => m.email === 'jane@acme.com')).toMatchObject({ status: 'active', principal: jane });
  });

  it('accepting with the wrong email is refused (the hash is the gate)', async () => {
    const acme = await makeTeam('acme2', 'owner@acme2.com');
    const ownerScope = await host.getScope(acme.principal, acme.tenantId, acme.scopeId);
    const { invitationId } = await ownerScope.invoke<{ invitationId: string }>('dashboard/invite-member', {
      email: 'jane@acme2.com',
      roleKey: 'viewer',
    });
    const mallory = principalId.parse(ulid());
    const malloryScope = await host.getScope(mallory, acme.tenantId, acme.scopeId);
    await expect(
      malloryScope.invoke('dashboard/accept-invite', { invitationId, identifier: 'mallory@evil.com' }),
    ).rejects.toThrow(/not acceptable/);
  });

  it('a member cannot invite (§5.1: they lack manage-members)', async () => {
    const acme = await makeTeam('acme3', 'owner@acme3.com');
    const ownerScope = await host.getScope(acme.principal, acme.tenantId, acme.scopeId);
    // Invite + accept a plain member.
    const { invitationId } = await ownerScope.invoke<{ invitationId: string }>('dashboard/invite-member', {
      email: 'sam@acme3.com',
      roleKey: 'member',
    });
    const sam = principalId.parse(ulid());
    const samScope = await host.getScope(sam, acme.tenantId, acme.scopeId);
    await samScope.invoke('dashboard/accept-invite', { invitationId, identifier: 'sam@acme3.com' });
    // Sam has 'member' access in-scope (read/provision) but NOT the role at the tenant
    // node yet — the worker assigns that. So to isolate the §5.1 check, grant Sam the
    // member role at the tenant node and confirm they still cannot invite anyone.
    await host.admin.assignRole(staff, { principalId: sam, roleKey: 'member', node: { tenantId: acme.tenantId, scopeId: null } });
    await expect(
      samScope.invoke('dashboard/invite-member', { email: 'x@acme3.com', roleKey: 'viewer' }),
    ).rejects.toThrow(/permission denied/);
  });

  it('removing an active member revokes their role (unassignRole) and drops them from the roster', async () => {
    const acme = await makeTeam('acme5', 'owner@acme5.com');
    const ownerScope = await host.getScope(acme.principal, acme.tenantId, acme.scopeId);
    const { invitationId } = await ownerScope.invoke<{ invitationId: string }>('dashboard/invite-member', {
      email: 'kim@acme5.com',
      roleKey: 'member',
    });
    const kim = principalId.parse(ulid());
    const kimScope = await host.getScope(kim, acme.tenantId, acme.scopeId);
    await kimScope.invoke('dashboard/accept-invite', { invitationId, identifier: 'kim@acme5.com' });
    // Mirror the worker's accept: assign Kim the member role (proven by a gated read
    // succeeding) and link her identity so the team is in her switcher.
    await host.admin.assignRole(staff, { principalId: kim, roleKey: 'member', node: { tenantId: acme.tenantId, scopeId: null } });
    await host.admin.linkIdentity(staff, { provider: PROVIDER, externalId: 'kim-sub', principal: kim, tenantId: acme.tenantId, scopeId: acme.scopeId });
    await expect(kimScope.invoke('dashboard/list-members', {})).resolves.toBeDefined();
    expect(await host.admin.listIdentityTenants(staff, PROVIDER, 'kim-sub')).toContain(acme.tenantId);

    // Remove her: the op returns what to unassign, then the worker (here, the test) cuts
    // access (unassignRole) AND severs her login (unlinkIdentity).
    const removed = await ownerScope.invoke<{ principal: string; roleKey: string } | null>('dashboard/remove-member', {
      memberId: (await members(acme)).find((m) => m.email === 'kim@acme5.com')!.id,
    });
    expect(removed).toMatchObject({ principal: kim, roleKey: 'member' });
    await host.admin.unassignRole(staff, { principalId: kim, roleKey: 'member', node: { tenantId: acme.tenantId, scopeId: null } });
    await host.admin.unlinkIdentity(staff, acme.tenantId, kim);

    // Access is gone (the gated read denies), she is off the roster, and the team no
    // longer appears in her switcher.
    await expect(kimScope.invoke('dashboard/list-members', {})).rejects.toThrow(/permission denied/);
    expect((await members(acme)).find((m) => m.email === 'kim@acme5.com')).toBeUndefined();
    expect(await host.admin.listIdentityTenants(staff, PROVIDER, 'kim-sub')).not.toContain(acme.tenantId);
  });

  it('the owner cannot be removed', async () => {
    const acme = await makeTeam('acme6', 'owner@acme6.com');
    const ownerScope = await host.getScope(acme.principal, acme.tenantId, acme.scopeId);
    const ownerRow = (await members(acme)).find((m) => m.role_key === 'owner')!;
    const removed = await ownerScope.invoke<{ principal: string } | null>('dashboard/remove-member', { memberId: ownerRow.id });
    expect(removed).toBeNull();
    expect((await members(acme)).find((m) => m.role_key === 'owner')).toBeDefined();
  });

  it('a revoked invite drops out of the roster and cannot be accepted', async () => {
    const acme = await makeTeam('acme4', 'owner@acme4.com');
    const ownerScope = await host.getScope(acme.principal, acme.tenantId, acme.scopeId);
    const { invitationId } = await ownerScope.invoke<{ invitationId: string }>('dashboard/invite-member', {
      email: 'gone@acme4.com',
      roleKey: 'member',
    });
    await ownerScope.invoke('dashboard/revoke-invite', { invitationId });
    expect((await members(acme)).find((m) => m.email === 'gone@acme4.com')).toBeUndefined();
    const p = principalId.parse(ulid());
    const pScope = await host.getScope(p, acme.tenantId, acme.scopeId);
    await expect(
      pScope.invoke('dashboard/accept-invite', { invitationId, identifier: 'gone@acme4.com' }),
    ).rejects.toThrow(/not acceptable/);
  });
});
