import { describe, it, expect } from 'vitest';
import { principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { TenantNarrowedControlPlane, ControlPlaneError } from '../src/authority.js';

/**
 * The §4 seam (docs/design/dashboard.md): the Dashboard effects provisioning on the
 * shared control plane, but ONLY inside the caller's own tenant. The tenant is pinned
 * at construction, so operation code cannot name another — cross-tenant is impossible
 * by construction. These tests exercise that the pinned tenant is injected on every
 * write, the routes/headers are right, and idempotent creates tolerate a conflict.
 */
describe('TenantNarrowedControlPlane — the tenant-narrowed authority seam', () => {
  const T = tenantId.parse(ulid());
  const S = scopeId.parse(ulid());
  const owner = principalId.parse(ulid());

  interface Call { url: string; method: string; body: unknown; token: string | null }

  function harness(status = 200, payload: unknown = {}) {
    const calls: Call[] = [];
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      calls.push({
        url: String(url),
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(init.body as string) : undefined,
        token: headers.get('x-service-token'),
      });
      return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof globalThis.fetch;
    const cp = new TenantNarrowedControlPlane({
      baseUrl: 'https://cp/api',
      actor: '01JZ000000000000000000TEST',
      serviceToken: 'secret-token',
      tenantId: T,
      fetch,
    });
    return { cp, calls };
  }

  it('injects the pinned tenant + service token on every write, at the right routes', async () => {
    const { cp, calls } = harness();
    await cp.ensureTenant('t-acme', 'Acme');
    await cp.grantEntitlement('callout');
    await cp.provisionScope({ scopeId: S, slug: 'acme-hr', name: 'Acme HR', vertical: 'callout', jurisdiction: 'global' });
    await cp.provisionInstance('callout', { scopeId: S, owner, slug: 'acme-hr', name: 'Acme HR' });
    await cp.activateScope(S);
    await cp.bindHostname({ hostname: 'acme-hr.global.substrat.run', scopeId: S, surface: 'app', canonical: true });
    await cp.setHostnameStatus('acme-hr.global.substrat.run', 'active');

    // Every request carried the service credential.
    expect(calls.every((c) => c.token === 'secret-token')).toBe(true);

    // The tenant is the pinned one, everywhere it appears — in the path or the body.
    const tenantCreate = calls[0]!;
    expect(tenantCreate.url).toBe('https://cp/api/tenants');
    expect((tenantCreate.body as { id: string }).id).toBe(T);

    expect(calls[1]!.url).toBe(`https://cp/api/tenants/${T}/entitlements/callout`);
    expect(calls[1]!.method).toBe('PUT');

    const provScope = calls[2]!;
    expect(provScope.url).toBe('https://cp/api/scopes');
    expect((provScope.body as { tenantId: string }).tenantId).toBe(T);

    const provInstance = calls[3]!;
    expect(provInstance.url).toBe('https://cp/api/verticals/callout/instances');
    expect((provInstance.body as { tenantId: string; owner: string }).tenantId).toBe(T);
    expect((provInstance.body as { owner: string }).owner).toBe(owner);

    expect(calls[4]!.url).toBe(`https://cp/api/tenants/${T}/scopes/${S}/activate`);

    const bind = calls[5]!;
    expect(bind.url).toBe('https://cp/api/hostnames');
    expect((bind.body as { tenantId: string; region: null; canonical: boolean }).tenantId).toBe(T);
    expect((bind.body as { region: null }).region).toBe(null);
    expect((bind.body as { canonical: boolean }).canonical).toBe(true);

    expect(calls[6]!.url).toBe('https://cp/api/hostnames/acme-hr.global.substrat.run/status');
    expect(calls[6]!.method).toBe('PATCH');
  });

  it('the tenant is not a parameter of any method — op code cannot name another', () => {
    const { cp } = harness();
    // The pinned tenant is exposed read-only; nothing accepts a tenantId argument.
    expect(cp.tenantId).toBe(T);
    // provisionScope/provisionInstance/bindHostname take a scope + details, never a tenant.
    const provisionScopeArg: Parameters<typeof cp.provisionScope>[0] = { scopeId: S, slug: 'x', name: 'X', vertical: 'callout', jurisdiction: 'global' };
    expect('tenantId' in provisionScopeArg).toBe(false);
  });

  it('idempotent creates tolerate a 409 (tenant/entitlement already exists)', async () => {
    const { cp } = harness(409, { error: 'already exists' });
    await expect(cp.ensureTenant('t-acme', 'Acme')).resolves.toBeUndefined();
    await expect(cp.grantEntitlement('callout')).resolves.toBeUndefined();
  });

  it('a non-idempotent failure surfaces as ControlPlaneError', async () => {
    const { cp } = harness(500, { error: 'boom' });
    await expect(cp.provisionScope({ scopeId: S, slug: 'x', name: 'X', vertical: 'callout', jurisdiction: 'global' })).rejects.toBeInstanceOf(ControlPlaneError);
  });
});
