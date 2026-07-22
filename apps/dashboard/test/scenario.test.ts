import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { platformActorId, principalId, scopeId, tenantId, type PermissionKey } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { protocolModule, PROTOCOL_PERM } from '@substrat-run/engine-protocol';
import { workorderModule } from '@substrat-run/engine-workorder';
import { invoicingModule } from '@substrat-run/engine-invoicing';
import { calloutModule } from '@substrat-run/demo-callout/module';
import {
  MODULES,
  provisionDashboard,
  createApp,
  type DashboardAppRow,
  type DashboardNode,
} from '../src/index.js';

/**
 * M0 — the central claim of docs/design/dashboard.md, cashed out: a tenant admin
 * self-provisions an app in THEIR OWN tenant, authorized by an in-scope permission
 * check, and cannot reach another tenant because the tenant is ambient (their
 * dashboard node), never a request argument.
 *
 * Apps here run the protocol engine — enough to prove a provisioned app is a real,
 * live scope, not a directory row. (In production each app is a separate vertical
 * deployment; this single-process host stands in for the platform.)
 */
describe('Dashboard M0 — tenant-narrowed self-service provisioning', () => {
  let dir: string;
  let host: SqliteScopeHost;
  let staff = platformActorId.parse(ulid());

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-dashboard-'));
    host = new SqliteScopeHost({ dir });
    for (const m of MODULES) host.registerModule(m); // the dashboard vertical
    // The verticals an app can run, bundled in-process (M0), mirroring worker.ts.
    for (const m of [protocolModule, workorderModule, invoicingModule, calloutModule]) {
      host.registerModule(m);
    }
    staff = platformActorId.parse(ulid());
  });

  afterEach(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Sign-up bootstrap: a customer's tenant + dashboard scope + owner. */
  const bootstrap = (slug: string): Promise<DashboardNode> =>
    provisionDashboard(host, {
      tenantId: tenantId.parse(ulid()),
      scopeId: scopeId.parse(ulid()),
      owner: principalId.parse(ulid()),
      slug,
      name: slug,
    });

  const scopeIds = async (t: DashboardNode['tenantId']): Promise<string[]> =>
    (await host.admin.listScopes(staff, { tenantId: t })).map((s) => s.id);

  it('an owner provisions an app that runs, in their own tenant, and it shows in their app list', async () => {
    const acme = await bootstrap('acme');
    const appScopeId = scopeId.parse(ulid());

    const app: DashboardAppRow = await createApp(host, {
      node: acme,
      appScopeId,
      verticalSlug: 'protocol',
      name: 'Onboarding',
      appEntitlements: ['protocol'],
      appOwnerGrants: [PROTOCOL_PERM.create, PROTOCOL_PERM.read] as PermissionKey[],
    });
    expect(app.status).toBe('active');
    // A default hostname is bound + recorded: `<slug>.<jurisdiction>.substrat.run` (K-30).
    expect(app.hostname).toBe('onboarding.global.substrat.run');

    // The app scope lives in ACME's tenant...
    expect(await scopeIds(acme.tenantId)).toContain(appScopeId);
    // ...and is a LIVE scope, not just a row: a real protocol op works on it.
    const appScope = await host.getScope(acme.principal, acme.tenantId, appScopeId);
    await appScope.invoke('protocol/define-template', {
      key: 'welcome',
      title: 'Welcome',
      content: { kind: 'document', documentType: 'welcome', hashRecipe: 'sha256 over the terms' },
    });
    expect(await appScope.invoke('protocol/list-templates', {})).toHaveLength(1);

    // ...and it shows in the account's own app list.
    const dash = await host.getScope(acme.principal, acme.tenantId, acme.scopeId);
    const apps = await dash.invoke<DashboardAppRow[]>('dashboard/list-apps', {});
    expect(apps.map((a) => a.app_scope_id)).toEqual([appScopeId]);
    expect(apps[0]!.status).toBe('active');
  });

  it('an owner provisions a real Callout app — a live multi-engine scope with a default hostname', async () => {
    const acme = await bootstrap('acme-callout');
    const appScopeId = scopeId.parse(ulid());

    const app = await createApp(host, {
      node: acme,
      appScopeId,
      verticalSlug: 'callout',
      name: 'Callout',
      // Callout composes three engines, so its SKU is three entitlement flags.
      appEntitlements: ['workorder', 'invoicing', 'protocol', 'callout'],
      appOwnerGrants: [PROTOCOL_PERM.create, PROTOCOL_PERM.read] as PermissionKey[],
    });
    expect(app.status).toBe('active');
    expect(app.vertical_slug).toBe('callout');
    expect(app.hostname).toBe('callout.global.substrat.run');
    expect(await scopeIds(acme.tenantId)).toContain(appScopeId);

    // It's a LIVE scope running the Callout bundle — a real engine op resolves
    // (protocol is one of the engines Callout composes, and the owner holds its keys).
    const appScope = await host.getScope(acme.principal, acme.tenantId, appScopeId);
    await appScope.invoke('protocol/define-template', {
      key: 'welcome',
      title: 'Welcome',
      content: { kind: 'document', documentType: 'welcome', hashRecipe: 'sha256 over the terms' },
    });
    expect(await appScope.invoke('protocol/list-templates', {})).toHaveLength(1);
  });

  it('a principal without dashboard:provision-app is refused — before anything is provisioned', async () => {
    const acme = await bootstrap('acme2');
    const stranger = principalId.parse(ulid()); // holds no role in acme
    const appScopeId = scopeId.parse(ulid());

    await expect(
      createApp(host, {
        node: { ...acme, principal: stranger },
        appScopeId,
        verticalSlug: 'protocol',
        name: 'X',
        appEntitlements: ['protocol'],
      }),
    ).rejects.toThrow();

    // The permission check runs first, so nothing was provisioned.
    expect(await scopeIds(acme.tenantId)).not.toContain(appScopeId);
  });

  it('a customer cannot provision into another tenant — even by supplying its node', async () => {
    const acme = await bootstrap('acme3');
    const other = await bootstrap('other');
    const appScopeId = scopeId.parse(ulid());

    // Acme's owner forges `other`'s node. The in-scope check refuses acme.principal
    // in other's tenant (they hold no role there), so no scope is provisioned —
    // authority is kernel-enforced, not a matter of passing the right tenant.
    await expect(
      createApp(host, {
        node: { tenantId: other.tenantId, scopeId: other.scopeId, principal: acme.principal },
        appScopeId,
        verticalSlug: 'protocol',
        name: 'X',
        appEntitlements: ['protocol'],
      }),
    ).rejects.toThrow();

    expect(await scopeIds(other.tenantId)).not.toContain(appScopeId);

    // And acme's own owner, on their own node, lands only in acme — never `other`.
    const own = scopeId.parse(ulid());
    await createApp(host, {
      node: acme,
      appScopeId: own,
      verticalSlug: 'protocol',
      name: 'A',
      appEntitlements: ['protocol'],
    });
    expect(await scopeIds(acme.tenantId)).toContain(own);
    expect(await scopeIds(other.tenantId)).not.toContain(own);
  });
});
