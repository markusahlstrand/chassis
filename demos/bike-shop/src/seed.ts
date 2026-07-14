import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  principalId,
  scopeId,
  tenantId,
  type PrincipalId,
  type ScopeId,
  type TenantId,
} from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { workorderModule, PERM as WO } from '@substrat-run/engine-workorder';
import { invoicingModule, INVOICING_PERM as INV } from '@substrat-run/engine-invoicing';
import { bikeShopModule, CS_PERM } from './module.js';

export interface BikeShopWorld {
  t1: TenantId; // Kedja & Kugghjul Cykelverkstad AB
  t2: TenantId; // Trampolin Cykel AB (the attack perpetrator's shop)
  s1: ScopeId; // Söder workshop (Kedja & Kugghjul)
  s2: ScopeId; // Trampolin's workshop
  greta: PrincipalId; // workshop-admin, t1 tenant-level
  mans: PrincipalId; // mechanic @ s1
  lisbeth: PrincipalId; // portal user, Crescent owner
  otto: PrincipalId; // portal user, Bianchi owner
  rutger: PrincipalId; // workshop-admin @ t2 — the attacker
  lisbethId: string; // customer Lisbeth Sandell
  ottoId: string; // customer Otto Vinge
  crescentId: string; // Lisbeth's bike
  bianchiId: string; // Otto's bike
}

export function buildBikeShopHost(dir: string): SqliteScopeHost {
  const host = new SqliteScopeHost({ dir }); // default checker: the tuple engine
  host.registerModule(workorderModule);
  host.registerModule(invoicingModule);
  host.registerModule(bikeShopModule);
  return host;
}

/** Idempotent: safe on every server start; demo data seeds only once. */
export async function seedBikeShop(host: SqliteScopeHost, dir: string): Promise<BikeShopWorld> {
  const castPath = join(dir, 'cast.json');
  const fresh = !existsSync(castPath);
  const raw: Record<string, string> = fresh
    ? {
        t1: ulid(), t2: ulid(), s1: ulid(), s2: ulid(),
        greta: ulid(), mans: ulid(), lisbeth: ulid(), otto: ulid(), rutger: ulid(),
        lisbethId: '', ottoId: '', crescentId: '', bianchiId: '',
      }
    : (JSON.parse(readFileSync(castPath, 'utf8')) as Record<string, string>);

  const world: BikeShopWorld = {
    t1: tenantId.parse(raw.t1), t2: tenantId.parse(raw.t2),
    s1: scopeId.parse(raw.s1), s2: scopeId.parse(raw.s2),
    greta: principalId.parse(raw.greta), mans: principalId.parse(raw.mans),
    lisbeth: principalId.parse(raw.lisbeth), otto: principalId.parse(raw.otto),
    rutger: principalId.parse(raw.rutger),
    lisbethId: raw.lisbethId ?? '', ottoId: raw.ottoId ?? '',
    crescentId: raw.crescentId ?? '', bianchiId: raw.bianchiId ?? '',
  };

  await host.provisionScope({ tenantId: world.t1, scopeId: world.s1, jurisdiction: 'eu' });
  await host.provisionScope({ tenantId: world.t2, scopeId: world.s2, jurisdiction: 'eu' });

  // Roles: identical definitions in both tenants (vertical-defined).
  const adminPerms = [
    CS_PERM.customerManage, CS_PERM.bikeManage,
    WO.create, WO.read, WO.assign, WO.report, WO.complete, WO.close,
    INV.read, INV.export,
  ];
  for (const t of [world.t1, world.t2]) {
    host.admin.defineRole(t, { key: 'workshop-admin', permissions: adminPerms, source: 'vertical' });
    host.admin.defineRole(t, { key: 'mechanic', permissions: [WO.read, WO.report], source: 'vertical' });
  }
  host.admin.assignRole({ principalId: world.greta, roleKey: 'workshop-admin', node: { tenantId: world.t1, scopeId: null } });
  host.admin.assignRole({ principalId: world.mans, roleKey: 'mechanic', node: { tenantId: world.t1, scopeId: world.s1 } });
  host.admin.assignRole({ principalId: world.rutger, roleKey: 'workshop-admin', node: { tenantId: world.t2, scopeId: null } });

  if (fresh) {
    const stub = await host.getScope(world.greta, world.t1, world.s1);
    const lisbeth = await stub.invoke<{ id: string }>('bike-shop/create-customer', {
      number: '2001', name: 'Lisbeth Sandell', phone: '070-123 45 67',
    });
    const otto = await stub.invoke<{ id: string }>('bike-shop/create-customer', {
      number: '2002', name: 'Otto Vinge',
    });
    const crescent = await stub.invoke<{ id: string }>('bike-shop/register-bike', {
      customerId: lisbeth.id, label: 'Crescent Elina 3-vxl', frameNo: 'CR-88412',
    });
    const bianchi = await stub.invoke<{ id: string }>('bike-shop/register-bike', {
      customerId: otto.id, label: 'Bianchi Oltre XR3',
    });
    await stub.invoke('bike-shop/upsert-price', {
      article: 'labor', description: 'Mekanikertid', unit: 'tim', priceAmount: '495', minQty: '0.5',
    });
    await stub.invoke('bike-shop/upsert-price', {
      article: 'verkstadsmtrl', description: 'Verkstadsmaterial', unit: 'st', priceAmount: '15', internal: true,
    });
    await stub.invoke('bike-shop/upsert-price', {
      article: 'sb:innerslang-28', description: 'Innerslang 28"', unit: 'st', priceAmount: '89',
    });
    await stub.invoke('bike-shop/upsert-price', {
      article: 'sb:kedja-9v', description: 'Kedja 9-växlad', unit: 'st', priceAmount: '249',
    });

    world.lisbethId = lisbeth.id;
    world.ottoId = otto.id;
    world.crescentId = crescent.id;
    world.bianchiId = bianchi.id;
    writeFileSync(castPath, JSON.stringify(world, null, 2));
  }

  // Portal grants (idempotent): entity-narrowed workorder:read per customer.
  if (world.lisbethId) {
    host.admin.grant({
      principalId: world.lisbeth, permission: WO.read,
      node: { tenantId: world.t1, scopeId: world.s1 },
      entity: { entityType: 'customer', entityId: world.lisbethId },
      grantedBy: world.greta,
    });
  }
  if (world.ottoId) {
    host.admin.grant({
      principalId: world.otto, permission: WO.read,
      node: { tenantId: world.t1, scopeId: world.s1 },
      entity: { entityType: 'customer', entityId: world.ottoId },
      grantedBy: world.greta,
    });
  }

  return world;
}
