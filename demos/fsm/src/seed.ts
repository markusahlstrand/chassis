import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  platformActorId,
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
import { protocolModule, PROTOCOL_PERM as PROTO } from '@substrat-run/engine-protocol';
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
  // Registration order is a migration-ordering contract: the protocol
  // engine's 0001-init must journal before serviceco's
  // 0003-protocols-to-engine copies milestone-A data into its tables.
  host.registerModule(protocolModule);
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

  // Control-plane dev actor (control-plane.md §6): locally the platform actor is
  // a stub. Every admin mutation below is stamped with it in the audit trail.
  const staff = platformActorId.parse(ulid());

  // Tenant registry (§4.1): create-then-provision, idempotent on every start.
  await host.admin.createTenant(staff, { id: world.t1, slug: 'elmontage', name: 'ElMontage AB' });
  await host.admin.createTenant(staff, { id: world.t2, slug: 'rorservice', name: 'RörService AB' });

  // Entitlements (§4.3): default-deny, so grant the SKU flags for the modules
  // ServiceCo runs before its operations resolve. This is the SKU model in use.
  for (const t of [world.t1, world.t2]) {
    for (const key of ['workorder', 'invoicing', 'protocol', 'serviceco']) {
      await host.admin.grantEntitlement(staff, t, key);
    }
  }

  await host.provisionScope(staff, { tenantId: world.t1, scopeId: world.s1, jurisdiction: 'eu' });
  await host.provisionScope(staff, { tenantId: world.t2, scopeId: world.s2, jurisdiction: 'eu' });

  // Roles: identical definitions in both tenants (vertical-defined).
  const officePerms = [
    SC_PERM.customerManage, SC_PERM.facilityManage,
    WO.create, WO.read, WO.assign, WO.report, WO.complete, WO.close,
    INV.read, INV.export,
    PROTO.create, PROTO.fill, PROTO.sign, PROTO.read, PROTO.void,
  ];
  for (const t of [world.t1, world.t2]) {
    await host.admin.defineRole(staff, t, { key: 'office-admin', permissions: officePerms, source: 'vertical' });
    // Technicians fill protocols; SIGNING stays with the office (arbetsledare) —
    // the fill/sign permission split from engine-protocol.md §4.6.
    await host.admin.defineRole(staff, t, {
      key: 'technician',
      permissions: [WO.read, WO.report, PROTO.read, PROTO.fill],
      source: 'vertical',
    });
  }
  await host.admin.assignRole(staff, { principalId: world.anna, roleKey: 'office-admin', node: { tenantId: world.t1, scopeId: null } });
  await host.admin.assignRole(staff, { principalId: world.harald, roleKey: 'technician', node: { tenantId: world.t1, scopeId: world.s1 } });
  await host.admin.assignRole(staff, { principalId: world.mallory, roleKey: 'office-admin', node: { tenantId: world.t2, scopeId: null } });

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

  // Branschprotokoll pack (idempotent, and outside `fresh` so existing demo
  // data gains it on restart): the electrical-trade egenkontroll — 100%
  // vertical content; only the invariants are protocol machinery.
  const stub = await host.getScope(world.anna, world.t1, world.s1);
  const templates = await stub.invoke<{ key: string }[]>('protocol/list-templates');
  if (!templates.some((t) => t.key === 'egenkontroll-el')) {
    await stub.invoke('protocol/define-template', {
      key: 'egenkontroll-el',
      title: 'Egenkontroll — Elinstallation',
      content: {
        sections: [
          {
            title: 'Före arbete',
            items: [
              { key: 'spanningslost', label: 'Anläggningsdel spänningslös och säkrad mot tillkoppling', type: 'check' },
              { key: 'ritningsunderlag', label: 'Ritningsunderlag och gruppförteckning aktuella', type: 'check' },
            ],
          },
          {
            title: 'Utförande',
            items: [
              { key: 'ledningsdragning', label: 'Ledningsdragning och förläggning enligt SS 436 40 00', type: 'check' },
              { key: 'kapslingsklass', label: 'Kapslingsklass anpassad till miljön', type: 'check' },
            ],
          },
          {
            title: 'Kontroll före idrifttagning',
            items: [
              { key: 'isolationsmatning', label: 'Isolationsmätning', type: 'value', unit: 'MΩ' },
              { key: 'kontinuitet', label: 'Kontinuitetsmätning av skyddsledare', type: 'value', unit: 'Ω' },
              { key: 'jordfelsbrytare', label: 'Jordfelsbrytare provad med testknapp och mätning', type: 'check' },
              { key: 'anmarkningar', label: 'Anmärkningar / avvikelser', type: 'text' },
            ],
          },
        ],
      },
    });
  }

  // Portal grants (idempotent): entity-narrowed workorder:read per customer.
  if (world.grundenId) {
    await host.admin.grant(staff, {
      principalId: world.berit, permission: WO.read,
      node: { tenantId: world.t1, scopeId: world.s1 },
      entity: { entityType: 'customer', entityId: world.grundenId },
      grantedBy: world.anna,
    });
  }
  if (world.kontorshotelletId) {
    await host.admin.grant(staff, {
      principalId: world.styrbjorn, permission: WO.read,
      node: { tenantId: world.t1, scopeId: world.s1 },
      entity: { entityType: 'customer', entityId: world.kontorshotelletId },
      grantedBy: world.anna,
    });
  }

  return world;
}
