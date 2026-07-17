import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { platformActorId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import {
  ControlPlaneClient,
  createControlPlaneApi,
  UNSAFE_devPlatformActorAuth,
} from '../src/index.js';

/**
 * The connect seam (first-flow.md slice 4): a vertical registers into a
 * separately-run control plane over HTTP and gates on its authoritative
 * lifecycle. Here the "control plane" is the router over a SqliteScopeHost and
 * the client calls it in-process via `app.fetch` — no network — but the boundary
 * is real: the client only ever sees the HTTP surface, exactly as a separate
 * deployment would.
 */
describe('ControlPlaneClient — the connect seam', () => {
  it('registers a tenant + scope and gates on the remote lifecycle', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cp-client-'));
    const host = new SqliteScopeHost({ dir });
    const actor = platformActorId.parse(ulid());
    const app = createControlPlaneApi({ host, authenticate: UNSAFE_devPlatformActorAuth() });

    const client = new ControlPlaneClient({
      baseUrl: 'http://cp.local',
      actor,
      fetch: (input, init) => app.fetch(new Request(input, init)),
    });

    const T = tenantId.parse(ulid());
    const S = scopeId.parse(ulid());

    // The vertical registers itself.
    await client.createTenant({ id: T, slug: 'acme', name: 'Acme' });
    await client.grantEntitlement(T, 'notes');
    await client.provisionScope({ tenantId: T, scopeId: S, slug: 'main', vertical: 'demo', jurisdiction: 'eu' });

    // Registered and active → the gate passes and the entitlement is visible.
    await expect(client.assertScopeActive(T, S)).resolves.toBeUndefined();
    expect(await client.listEntitlements(T)).toContain('notes');

    // The console suspends the scope on the control plane → the vertical's gate
    // now fails closed, across the HTTP boundary.
    await host.admin.suspendScope(actor, T, S);
    await expect(client.assertScopeActive(T, S)).rejects.toThrow(/scope not active/);

    // Unsuspend → passes again. Suspend the TENANT → the cascade fails closed
    // too, which a scope-status-only check would miss.
    await host.admin.unsuspendScope(actor, T, S);
    await expect(client.assertScopeActive(T, S)).resolves.toBeUndefined();
    await host.admin.setTenantStatus(actor, T, 'suspended');
    await expect(client.assertScopeActive(T, S)).rejects.toThrow(/tenant not active/);
  });

  it('fails closed when the control plane is unreachable', async () => {
    const client = new ControlPlaneClient({
      baseUrl: 'http://cp.local',
      actor: platformActorId.parse(ulid()),
      fetch: () => Promise.reject(new Error('ECONNREFUSED')),
    });
    await expect(
      client.assertScopeActive(tenantId.parse(ulid()), scopeId.parse(ulid())),
    ).rejects.toThrow(/control plane unreachable/);
  });
});
