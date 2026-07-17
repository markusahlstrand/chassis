/**
 * Local dev server for the control-plane API — the thing the console points at.
 *
 * Deliberately NOT in `src/`: it is harness code, node-only, and outside the
 * published `files`. The package itself stays web-standard so the same router
 * mounts inside a Worker (control-plane.md §5.5).
 *
 * It binds 127.0.0.1 and runs the UNSAFE dev actor stub, which is the only
 * posture §6 permits: "real auth gates EXPOSING the console, not BUILDING it —
 * nothing with cross-tenant reach goes anywhere non-local on a stub."
 */
import { serve } from '@hono/node-server';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { ulid } from '@substrat-run/kernel';
import { platformActorId, scopeId, tenantId } from '@substrat-run/contracts';
import { createControlPlaneApi, DEV_ACTOR_HEADER, UNSAFE_devPlatformActorAuth } from '../src/index.js';

const dir = process.env.SUBSTRAT_DIR ?? mkdtempSync(join(tmpdir(), 'substrat-cp-'));
const host = new SqliteScopeHost({ dir });
const staff = platformActorId.parse(ulid());

// A small fleet, so the console has something with real shape to render:
// several tenants, a suspended one (whose scopes fail closed by cascade), a
// couple of verticals, and every scope status the badge mapping covers.
const world = [
  { slug: 'acme', name: 'Acme Fastigheter', status: 'active', skus: ['workorder', 'invoicing'],
    scopes: [
      { slug: 'brf-vasastan', kind: 'brf', name: 'Brf Vasastan', vertical: 'housing', status: 'active' },
      { slug: 'brf-sjostaden', kind: 'brf', name: 'Brf Sjöstaden', vertical: 'housing', status: 'active' },
      { slug: 'brf-eken', kind: 'brf', name: 'Brf Eken', vertical: 'housing', status: 'archived' },
    ] },
  { slug: 'nordan', name: 'Nordan Bygg', status: 'active', skus: ['workorder'],
    scopes: [
      { slug: 'hq', kind: 'branch', name: 'Nordan Bygg HQ', vertical: 'fsm', status: 'active' },
      { slug: 'syd', kind: 'branch', name: 'Nordan Bygg Syd', vertical: 'fsm', status: 'suspended' },
    ] },
  // Suspended tenant: its scopes stay stored-active but every one fails closed.
  // This is the cascade the console renders as "via tenant".
  { slug: 'kiosk', name: 'Kiosk Kedjan', status: 'suspended', skus: ['shop'],
    scopes: [{ slug: 'main', kind: 'brand', name: 'Kiosk Main', vertical: 'shop', status: 'active' }] },
] as const;

// CP_SKIP_SEED starts the control plane EMPTY — used by the connected topology
// (`pnpm dev:connected`), where a real vertical registers its own tenants/scopes
// over HTTP and the fake fleet below would only be noise.
if (!process.env.CP_SKIP_SEED)
for (const t of world) {
  const tid = tenantId.parse(ulid());
  await host.admin.createTenant(staff, { id: tid, slug: t.slug, name: t.name });
  for (const key of t.skus) await host.admin.grantEntitlement(staff, tid, key);
  for (const s of t.scopes) {
    const sid = scopeId.parse(ulid());
    await host.provisionScope(staff, {
      tenantId: tid, scopeId: sid, slug: s.slug, kind: s.kind, name: s.name,
      vertical: s.vertical, jurisdiction: 'eu',
    });
    if (s.status === 'suspended') await host.admin.suspendScope(staff, tid, sid);
    if (s.status === 'archived') await host.admin.archiveScope(staff, tid, sid);
  }
  // Suspend the tenant last, so its scopes provision first.
  if (t.status === 'suspended') await host.admin.setTenantStatus(staff, tid, 'suspended');
}

// A role, then the same role redefined — which is the whole point of the
// permission checkpoint. `defineRole` captures before/after, so the second call
// is what the console's "Needs review" tab renders as a real diff: site-manager
// silently gaining invoice:read is exactly the change a human is meant to catch.
const [firstTenant] = await host.admin.listTenants();
if (firstTenant) {
  await host.admin.defineRole(staff, firstTenant.id, {
    key: 'site-manager',
    permissions: ['workorder:read', 'workorder:create', 'workorder:close'],
    source: 'vertical',
  });
  await host.admin.defineRole(staff, firstTenant.id, {
    key: 'site-manager',
    permissions: ['workorder:read', 'workorder:create', 'workorder:close', 'invoice:read'],
    source: 'vertical',
  });
  // A second source, so the Roles tab's filter has something to distinguish.
  // Both of these are code-declared — an engine's manifest and a vertical's
  // constants. Nothing seeds an operator-created role because nothing can make
  // one: role writes are not on the HTTP surface, and `source` has no value for it.
  await host.admin.defineRole(staff, firstTenant.id, {
    key: 'technician',
    permissions: ['workorder:read', 'workorder:close'],
    source: '@substrat-run/engine-workorder',
  });
}

const app = createControlPlaneApi({ host, authenticate: UNSAFE_devPlatformActorAuth() });
const port = Number(process.env.PORT ?? 8788);

serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, (info) => {
  console.log(`control-plane API  http://127.0.0.1:${info.port}`);
  console.log(`directory          ${dir}`);
  console.log(`dev actor          ${DEV_ACTOR_HEADER}: ${staff}`);
  console.log(`\n  curl -s -H '${DEV_ACTOR_HEADER}: ${staff}' http://127.0.0.1:${info.port}/tenants\n`);
});
