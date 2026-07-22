import type { AppRow, CatalogEntry, Me } from './api';

/**
 * Dev-preview mode — the Dashboard's analogue of the console's `VITE_DEV_ACTOR`
 * seam (apps/console/src/App.tsx). When `VITE_DEV_MOCK` is set at build/dev time,
 * the app skips the OIDC-gated `/api/*` calls and renders against the demo "Acme"
 * tenant, so the whole UI can be built and reviewed without standing up AuthHero.
 * It is NOT authentication and never ships enabled: the real deploy has no
 * `VITE_DEV_MOCK`, so the app always runs the real session + API path there.
 */
export const DEV_MOCK = import.meta.env.VITE_DEV_MOCK === '1' || import.meta.env.VITE_DEV_MOCK === 'true';

export const MOCK_ME: Me = {
  principal: '01J2Q8Z3V9K4W7X2M5N6P7OWNR' as Me['principal'],
  tenant: '01J2Q8Z3V9K4W7X2M5N6P7TNT0' as Me['tenant'],
  dashboardScope: '01J2Q8Z3V9K4W7X2M5N6P7DASH' as Me['dashboardScope'],
  email: 'dana@acme.com',
  name: 'Dana',
};

export const MOCK_CATALOG: CatalogEntry[] = [{ slug: 'protocol', name: 'Documents' }];

const now = Date.parse('2026-07-22T18:00:00Z');
const ago = (ms: number) => new Date(now - ms).toISOString();

export const MOCK_APPS: AppRow[] = [
  { id: '1', app_scope_id: '01J2Q8Z3V9K4W7X2M5N6P789AB', vertical_slug: 'protocol', name: 'Acme HR', status: 'active', hostname: 'acme-hr.substrat.run', created_by: 'dana@acme.com', created_at: ago(2 * 3600e3) },
  { id: '2', app_scope_id: '01J2Q8Z3V9K4W7X2M5N6P7LEGA', vertical_slug: 'protocol', name: 'Acme Legal', status: 'active', hostname: 'acme-legal.substrat.run', created_by: 'dana@acme.com', created_at: ago(30 * 3600e3) },
  { id: '3', app_scope_id: '01J2Q8Z3V9K4W7X2M5N6P7FIEL', vertical_slug: 'workorder', name: 'Acme Field Ops', status: 'provisioning', hostname: null, created_by: 'dana@acme.com', created_at: ago(20e3) },
  { id: '4', app_scope_id: '01J2Q8Z3V9K4W7X2M5N6P7FINA', vertical_slug: 'invoicing', name: 'Acme Finance', status: 'failed', hostname: null, created_by: 'dana@acme.com', created_at: ago(3 * 86400e3) },
];
