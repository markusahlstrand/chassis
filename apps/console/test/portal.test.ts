import { describe, expect, it } from 'vitest';
import type { HostnameBinding, Scope } from '@substrat-run/contracts';
import { portalUrl, portalUrls } from '../src/lib/portal';

/**
 * Which door the console sends staff to. Getting this wrong means either a link
 * that 404s (pointing at a hostname the router will not serve) or no link at all
 * for a scope that is perfectly reachable.
 */

const scope = { id: 'S1', tenantId: 'T1' } as unknown as Scope;
const other = { id: 'S2', tenantId: 'T1' } as unknown as Scope;

const binding = (over: Partial<HostnameBinding>): HostnameBinding =>
  ({
    hostname: 'a.example.com',
    tenantId: 'T1',
    scopeId: 'S1',
    verticalSlug: 'fsm',
    surface: 'app',
    region: null,
    status: 'active',
    statusNote: null,
    canonical: false,
    createdAt: '2026-07-19T00:00:00.000Z',
    ...over,
  }) as unknown as HostnameBinding;

describe('portalUrl', () => {
  it('links to the canonical active hostname', () => {
    const url = portalUrl(scope, [
      binding({ hostname: 'alias.example.com' }),
      binding({ hostname: 'acme.example.com', canonical: true }),
    ]);
    expect(url).toBe('https://acme.example.com');
  });

  it('falls back to an alias when no canonical is active', () => {
    // An alias resolves just as well. Insisting on the flag would show no link
    // for a scope that is reachable.
    expect(portalUrl(scope, [binding({ hostname: 'alias.example.com' })])).toBe(
      'https://alias.example.com',
    );
  });

  it('ignores hostnames that do not serve traffic', () => {
    // The router only resolves `active`, so a link to anything else leads nowhere.
    // No link is more honest than a broken one.
    for (const status of ['pending', 'verifying', 'failed'] as const) {
      expect(portalUrl(scope, [binding({ status })])).toBeNull();
    }
  });

  it('prefers an active alias over a canonical that is down', () => {
    const url = portalUrl(scope, [
      binding({ hostname: 'down.example.com', canonical: true, status: 'failed' }),
      binding({ hostname: 'up.example.com' }),
    ]);
    expect(url).toBe('https://up.example.com');
  });

  it('does not link to another scope’s hostname', () => {
    expect(portalUrl(other, [binding({ hostname: 'acme.example.com' })])).toBeNull();
  });

  it('selects by surface, because one scope can front several apps', () => {
    const bindings = [
      binding({ hostname: 'shop.example.com', surface: 'storefront', canonical: true }),
      binding({ hostname: 'admin.example.com', surface: 'back-office', canonical: true }),
    ];
    expect(portalUrl(scope, bindings, 'storefront')).toBe('https://shop.example.com');
    expect(portalUrl(scope, bindings, 'back-office')).toBe('https://admin.example.com');
    // A surface nothing is bound to has no link, rather than borrowing another's.
    expect(portalUrl(scope, bindings, 'app')).toBeNull();
  });

  it('returns null with no bindings and no dev fallback configured', () => {
    expect(portalUrl(scope, [])).toBeNull();
  });
});

describe('portalUrls', () => {
  it('lists every surface the scope answers on', () => {
    const urls = portalUrls(scope, [
      binding({ hostname: 'shop.example.com', surface: 'storefront', canonical: true }),
      binding({ hostname: 'admin.example.com', surface: 'back-office', canonical: true }),
      binding({ hostname: 'soon.example.com', surface: 'kiosk', status: 'pending' }),
    ]);
    // The pending one is absent: it is bound, but it does not answer yet.
    expect(urls).toEqual([
      { surface: 'back-office', url: 'https://admin.example.com' },
      { surface: 'storefront', url: 'https://shop.example.com' },
    ]);
  });
});
