import { describe, expect, it, vi } from 'vitest';
import type { PrincipalId, ScopeId, TenantId } from '@substrat-run/contracts';
import { createInstance, InstanceStepError } from '../src/lib/create-instance';
import type { Api } from '../src/lib/api';

/**
 * The order is the point. Every property this sequence protects comes from doing
 * these in exactly this order, so these tests assert the order rather than the
 * outcome.
 */

const ids = {
  tenantId: '01JZ00000000000000000000T1' as TenantId,
  scopeId: '01JZ00000000000000000000S1' as ScopeId,
  owner: '01JZ00000000000000000000OW' as PrincipalId,
};

function fakeApi(overrides: Partial<Record<keyof Api, unknown>> = {}) {
  const calls: string[] = [];
  const rec =
    (name: string, result: unknown = {}) =>
    async (...args: unknown[]) => {
      calls.push(name);
      const override = overrides[name as keyof Api];
      if (typeof override === 'function') return (override as (...a: unknown[]) => unknown)(...args);
      return result;
    };
  const api = {
    createTenant: rec('createTenant'),
    provisionInstance: rec('provisionInstance'),
    provisionScope: rec('provisionScope'),
    bindHostname: rec('bindHostname'),
    setHostnameStatus: rec('setHostnameStatus'),
  } as unknown as Api;
  return { api, calls };
}

describe('createInstance', () => {
  it('provisions the VERTICAL before recording the directory row', async () => {
    // The other order would leave a directory row promising a scope that does not
    // exist. This way a failure leaves an orphan nobody can see.
    const { api, calls } = fakeApi();
    await createInstance(api, { ...ids, verticalSlug: 'fsm', slug: 'acme', name: 'Acme' });
    expect(calls).toEqual(['createTenant', 'provisionInstance', 'provisionScope']);
  });

  it('activates the hostname LAST', async () => {
    // A hostname must never resolve before the thing behind it exists (K-26).
    const { api, calls } = fakeApi();
    const result = await createInstance(api, {
      ...ids,
      verticalSlug: 'fsm',
      slug: 'acme',
      name: 'Acme',
      hostname: 'acme.example.com',
    });
    expect(calls).toEqual([
      'createTenant',
      'provisionInstance',
      'provisionScope',
      'bindHostname',
      'setHostnameStatus',
    ]);
    expect(result.url).toBe('https://acme.example.com');
  });

  it('stops at the failing step and names it', async () => {
    // "It failed" is not actionable across two systems — which step ran decides
    // whether there is an orphan, a broken tenant, or nothing at all.
    const { api, calls } = fakeApi({
      provisionInstance: async () => {
        throw new Error('no deployment is bound for vertical');
      },
    });
    await expect(
      createInstance(api, { ...ids, verticalSlug: 'ghost', slug: 'acme', name: 'Acme' }),
    ).rejects.toThrow(InstanceStepError);
    // The directory row is NOT written when the vertical refused.
    expect(calls).toEqual(['createTenant', 'provisionInstance']);
  });

  it('carries the failing step, not just a message', async () => {
    const { api } = fakeApi({
      setHostnameStatus: async () => {
        throw new Error('unknown hostname');
      },
    });
    const err = await createInstance(api, {
      ...ids,
      verticalSlug: 'fsm',
      slug: 'acme',
      name: 'Acme',
      hostname: 'acme.example.com',
    }).catch((e) => e as InstanceStepError);
    expect(err.step).toBe('activate');
    expect(err.message).toContain('Activate');
  });

  it('skips hostname steps entirely when none is given', async () => {
    // An instance with no hostname is legitimate — it exists and is unreachable.
    // It must not bind an empty string.
    const { api, calls } = fakeApi();
    const result = await createInstance(api, {
      ...ids,
      verticalSlug: 'fsm',
      slug: 'acme',
      name: 'Acme',
      hostname: '   ',
    });
    expect(calls).not.toContain('bindHostname');
    expect(result.url).toBeNull();
  });

  it('lower-cases the hostname before binding it', async () => {
    const bind = vi.fn(async () => ({}));
    const { api } = fakeApi({ bindHostname: bind });
    await createInstance(api, {
      ...ids,
      verticalSlug: 'fsm',
      slug: 'acme',
      name: 'Acme',
      hostname: 'ACME.Example.COM',
    });
    expect(bind).toHaveBeenCalledWith(expect.objectContaining({ hostname: 'acme.example.com' }));
  });
});
