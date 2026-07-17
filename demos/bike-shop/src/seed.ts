import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  type PermissionKey,
  type PrincipalId,
  type RoleDefinition,
  type ScopeId,
  type TenantId,
} from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { workorderModule, PERM as WO } from '@substrat-run/engine-workorder';
import { invoicingModule, INVOICING_PERM as INV } from '@substrat-run/engine-invoicing';
import { protocolModule, PROTOCOL_PERM as PROTO } from '@substrat-run/engine-protocol';
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

/**
 * The modules this vertical composes, in registration order. Exported because
 * `tools/permission-diff.mts` renders the permission checkpoint from this same
 * array — the emitter and the running host read the one object, so the artifact
 * cannot drift from what is actually registered.
 */
export const MODULES = [workorderModule, invoicingModule, protocolModule, bikeShopModule];

// protocol:countersign is deliberately in NO role: the counter-signature is the
// CUSTOMER's act at pickup, granted entity-narrowed per customer via
// ENTITY_GRANTS — not even the verkstadschef can counter-sign on the customer's
// behalf. The permission snapshot renders it as held by no role, which is the
// design working, not a gap.
const adminPerms = [
  CS_PERM.customerManage, CS_PERM.bikeManage,
  WO.create, WO.read, WO.assign, WO.report, WO.complete, WO.close,
  INV.read, INV.export,
  PROTO.create, PROTO.fill, PROTO.sign, PROTO.read, PROTO.void,
];

/**
 * This vertical's role table — identical in every tenant, which is why it is a
 * plain constant and why the permission snapshot can render it without naming a
 * tenant. Per-tenant customisation is a console concern (runtime), not a
 * build-time one. Exported for the same reason as MODULES.
 */
export const ROLES: RoleDefinition[] = [
  { key: 'workshop-admin', permissions: adminPerms, source: 'vertical' },
  // The mechanic fills the condition report; SIGNING stays with the workshop
  // lead — the fill/sign permission split (engine-protocol.md §4.6).
  { key: 'mechanic', permissions: [WO.read, WO.report, PROTO.read, PROTO.fill], source: 'vertical' },
];

/**
 * What a portal customer receives, narrowed to their own customer record.
 * workorder:read lets them see their repairs; protocol:read + protocol:countersign
 * let them review and counter-sign the condition report at pickup — the grants
 * resolve along protocol → workorder → bike → customer.
 */
const portalPerms = [WO.read, PROTO.read, PROTO.countersign];

/**
 * Entity-narrowed grant SHAPES. The grants themselves are per-principal and
 * minted at runtime, so they can never be a build artifact; their shape can, and
 * it is what tells a reviewer which keys are reachable outside the role table —
 * protocol:countersign above all.
 */
export const ENTITY_GRANTS: { entityType: string; permissions: PermissionKey[] }[] = [
  { entityType: 'customer', permissions: portalPerms },
];

export function buildBikeShopHost(dir: string): SqliteScopeHost {
  const host = new SqliteScopeHost({ dir }); // default checker: the tuple engine
  for (const m of MODULES) host.registerModule(m);
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

  // Control-plane dev actor (control-plane.md §6): the platform actor is a local
  // stub; every admin mutation below is stamped with it in the audit trail.
  const staff = platformActorId.parse(ulid());

  // Tenant registry (§4.1): create-then-provision, idempotent on every start.
  await host.admin.createTenant(staff, {
    id: world.t1, slug: 'kedja-kugghjul', name: 'Kedja & Kugghjul Cykelverkstad AB',
  });
  await host.admin.createTenant(staff, { id: world.t2, slug: 'trampolin', name: 'Trampolin Cykel AB' });

  // Entitlements (§4.3): default-deny — grant the SKU flags for the modules the
  // workshop runs before its operations resolve.
  for (const t of [world.t1, world.t2]) {
    for (const key of ['workorder', 'invoicing', 'protocol', 'cykelservice']) {
      await host.admin.grantEntitlement(staff, t, key);
    }
  }

  await host.provisionScope(staff, { tenantId: world.t1, scopeId: world.s1, jurisdiction: 'eu' });
  await host.provisionScope(staff, { tenantId: world.t2, scopeId: world.s2, jurisdiction: 'eu' });

  // Roles: identical definitions in both tenants (vertical-defined).
  // Roles: identical definitions in both tenants (vertical-defined) — see ROLES.
  for (const t of [world.t1, world.t2]) {
    for (const role of ROLES) await host.admin.defineRole(staff, t, role);
  }
  await host.admin.assignRole(staff, { principalId: world.greta, roleKey: 'workshop-admin', node: { tenantId: world.t1, scopeId: null } });
  await host.admin.assignRole(staff, { principalId: world.mans, roleKey: 'mechanic', node: { tenantId: world.t1, scopeId: world.s1 } });
  await host.admin.assignRole(staff, { principalId: world.rutger, roleKey: 'workshop-admin', node: { tenantId: world.t2, scopeId: null } });

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

  // The tillståndsrapport template (idempotent, outside `fresh` so existing
  // demo data gains it on restart): per-bike condition report, filled at
  // intake/during the repair, signed by the workshop, counter-signed by the
  // customer at pickup — 100% CykelService content; only the invariants are
  // protocol machinery.
  const stub = await host.getScope(world.greta, world.t1, world.s1);
  const templates = await stub.invoke<{ key: string }[]>('protocol/list-templates');
  if (!templates.some((t) => t.key === 'tillstandsrapport')) {
    await stub.invoke('protocol/define-template', {
      key: 'tillstandsrapport',
      title: 'Tillståndsrapport — cykel',
      content: {
        sections: [
          {
            title: 'Vid inlämning',
            items: [
              { key: 'ramskador', label: 'Ramskador / lackskador noterade', type: 'text' },
              { key: 'dack-monsterdjup', label: 'Däck: skick och mönster', type: 'text' },
              { key: 'belysning-fungerar', label: 'Belysning fungerar', type: 'check' },
              { key: 'tillbehor', label: 'Medföljande tillbehör (lås, korg, …)', type: 'text' },
            ],
          },
          {
            title: 'Efter reparation',
            items: [
              { key: 'bromsar-ok', label: 'Bromsar kontrollerade fram och bak', type: 'check' },
              { key: 'vaxlar-ok', label: 'Växlar justerade och testade', type: 'check' },
              { key: 'ekerspanning', label: 'Ekerspänning bakhjul', type: 'value', unit: 'Nm' },
              { key: 'provkord', label: 'Provkörd efter reparation', type: 'check' },
              { key: 'anmarkningar', label: 'Anmärkningar till kunden', type: 'text' },
            ],
          },
        ],
      },
    });
  }

  // Portal grants (idempotent): entity-narrowed per customer — see ENTITY_GRANTS.
  if (world.lisbethId) {
    for (const permission of portalPerms) {
      await host.admin.grant(staff, {
        principalId: world.lisbeth, permission,
        node: { tenantId: world.t1, scopeId: world.s1 },
        entity: { entityType: 'customer', entityId: world.lisbethId },
        grantedBy: world.greta,
      });
    }
  }
  if (world.ottoId) {
    for (const permission of portalPerms) {
      await host.admin.grant(staff, {
        principalId: world.otto, permission,
        node: { tenantId: world.t1, scopeId: world.s1 },
        entity: { entityType: 'customer', entityId: world.ottoId },
        grantedBy: world.greta,
      });
    }
  }

  return world;
}
