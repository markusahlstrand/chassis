import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  principalId,
  scopeId,
  tenantId,
  type PrincipalId,
  type ScopeId,
  type TenantId,
} from '@substrat/contracts';
import { ulid } from '@substrat/kernel';
import { SqliteScopeHost } from '@substrat/adapter-sqlite';
import { workorderModule, PERM as WO } from '@substrat/engine-workorder';
import { invoicingModule, INVOICING_PERM as INV } from '@substrat/engine-invoicing';
import { servicecoModule, SC_PERM } from './module.js';

export interface DemoWorld {
  t1: TenantId; // ElMontage AB
  t2: TenantId; // RörService AB (the attack victim owner)
  s1: ScopeId; // Stockholm (ElMontage)
  s2: ScopeId; // Göteborg (RörService)
  anna: PrincipalId; // office-admin, t1 tenant-level
  harald: PrincipalId; // technician @ s1
  berit: PrincipalId; // portal user, customer BRF Grunden
  styrbjorn: PrincipalId; // portal user, customer Kontorshotellet
  mallory: PrincipalId; // office-admin @ t2 — the attacker
  grundenId: string; // customer BRF Grunden
  kontorshotelletId: string; // customer Kontorshotellet
  forskolanId: string; // facility of BRF Grunden
  kontorId: string; // facility of Kontorshotellet
}

export function buildDemoHost(dir: string): SqliteScopeHost {
  const host = new SqliteScopeHost({ dir }); // default checker: the tuple engine
  host.registerModule(workorderModule);
  host.registerModule(invoicingModule);
  host.registerModule(servicecoModule);
  return host;
}

/** Idempotent: safe on every server start; demo data seeds only once. */
export async function seedDemo(host: SqliteScopeHost, dir: string): Promise<DemoWorld> {
  const castPath = join(dir, 'cast.json');
  const fresh = !existsSync(castPath);
  const raw: Record<string, string> = fresh
    ? {
        t1: ulid(), t2: ulid(), s1: ulid(), s2: ulid(),
        anna: ulid(), harald: ulid(), berit: ulid(), styrbjorn: ulid(), mallory: ulid(),
        grundenId: '', kontorshotelletId: '', forskolanId: '', kontorId: '',
      }
    : (JSON.parse(readFileSync(castPath, 'utf8')) as Record<string, string>);

  const world: DemoWorld = {
    t1: tenantId.parse(raw.t1), t2: tenantId.parse(raw.t2),
    s1: scopeId.parse(raw.s1), s2: scopeId.parse(raw.s2),
    anna: principalId.parse(raw.anna), harald: principalId.parse(raw.harald),
    berit: principalId.parse(raw.berit), styrbjorn: principalId.parse(raw.styrbjorn),
    mallory: principalId.parse(raw.mallory),
    grundenId: raw.grundenId ?? '', kontorshotelletId: raw.kontorshotelletId ?? '',
    forskolanId: raw.forskolanId ?? '', kontorId: raw.kontorId ?? '',
  };

  await host.provisionScope({ tenantId: world.t1, scopeId: world.s1, jurisdiction: 'eu' });
  await host.provisionScope({ tenantId: world.t2, scopeId: world.s2, jurisdiction: 'eu' });

  // Roles: identical definitions in both tenants (vertical-defined).
  const officePerms = [
    SC_PERM.customerManage, SC_PERM.facilityManage,
    WO.create, WO.read, WO.assign, WO.report, WO.complete, WO.close,
    INV.read, INV.export,
  ];
  for (const t of [world.t1, world.t2]) {
    host.admin.defineRole(t, { key: 'office-admin', permissions: officePerms, source: 'vertical' });
    host.admin.defineRole(t, { key: 'technician', permissions: [WO.read, WO.report], source: 'vertical' });
  }
  host.admin.assignRole({ principalId: world.anna, roleKey: 'office-admin', node: { tenantId: world.t1, scopeId: null } });
  host.admin.assignRole({ principalId: world.harald, roleKey: 'technician', node: { tenantId: world.t1, scopeId: world.s1 } });
  host.admin.assignRole({ principalId: world.mallory, roleKey: 'office-admin', node: { tenantId: world.t2, scopeId: null } });

  if (fresh) {
    const stub = await host.getScope(world.anna, world.t1, world.s1);
    const grunden = await stub.invoke<{ id: string }>('serviceco/create-customer', {
      number: '1001', name: 'BRF Grunden', orgRef: 'org:brf-grunden',
    });
    const kontorshotellet = await stub.invoke<{ id: string }>('serviceco/create-customer', {
      number: '1002', name: 'Kontorshotellet AB',
    });
    const forskolan = await stub.invoke<{ id: string }>('serviceco/create-facility', {
      customerId: grunden.id, name: 'Förskolan Grunden', address: 'Storgatan 1, Stockholm',
      accessNote: 'Portkod 2295. Nyckel till förråd i receptionen.',
    });
    const kontor = await stub.invoke<{ id: string }>('serviceco/create-facility', {
      customerId: kontorshotellet.id, name: 'Kontorshotellet Vasastan', address: 'Vasagatan 12, Stockholm',
    });
    await stub.invoke('serviceco/upsert-price', {
      article: 'labor', description: 'Arbetstid', unit: 'tim', priceAmount: '515', minQty: '1.5',
    });
    await stub.invoke('serviceco/upsert-price', {
      article: 'travel-km', description: 'Restid', unit: 'km', priceAmount: '6', internal: true,
    });
    await stub.invoke('serviceco/upsert-price', {
      article: 'mat:fan-motor-15w', description: 'Fläktmotor 15W', unit: 'st', priceAmount: '1150',
    });

    world.grundenId = grunden.id;
    world.kontorshotelletId = kontorshotellet.id;
    world.forskolanId = forskolan.id;
    world.kontorId = kontor.id;
    writeFileSync(castPath, JSON.stringify(world, null, 2));
  }

  // Portal grants (idempotent): entity-narrowed workorder:read per customer.
  if (world.grundenId) {
    host.admin.grant({
      principalId: world.berit, permission: WO.read,
      node: { tenantId: world.t1, scopeId: world.s1 },
      entity: { entityType: 'customer', entityId: world.grundenId },
      grantedBy: world.anna,
    });
  }
  if (world.kontorshotelletId) {
    host.admin.grant({
      principalId: world.styrbjorn, permission: WO.read,
      node: { tenantId: world.t1, scopeId: world.s1 },
      entity: { entityType: 'customer', entityId: world.kontorshotelletId },
      grantedBy: world.anna,
    });
  }

  return world;
}
