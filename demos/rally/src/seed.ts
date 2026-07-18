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
import { bookingModule, PERM as BK } from '@substrat-run/engine-booking';
import { invoicingModule, INVOICING_PERM as INV } from '@substrat-run/engine-invoicing';
import { rallyModule, RALLY_PERM as RP } from './module.js';

export interface RallyWorld {
  t1: TenantId; // RallyPoint AB
  t2: TenantId; // Padelcenter Väst AB — the attacker's club
  s1: ScopeId; // Solna venue
  s1b: ScopeId; // Nacka venue (same tenant, second venue)
  s2: ScopeId; // Göteborg (t2)
  astrid: PrincipalId; // club-admin, t1 tenant-level (both venues)
  ravi: PrincipalId; // receptionist @ Solna only
  nils: PrincipalId; // coach @ Solna
  elin: PrincipalId; // player / portal principal
  johan: PrincipalId; // player / portal principal
  rutger: PrincipalId; // club-admin @ t2 — the cross-tenant attacker
  court1: string; // Bana 1 (indoor)
  court2: string; // Bana 2 (indoor)
  elinId: string; // member record
  johanId: string; // member record
  elinParty: string; // Elin's global player ref (DataSubjectId)
  johanParty: string;
}

/**
 * The modules this vertical composes, in registration order. Exported because
 * `tools/permission-diff.mts` renders the permission checkpoint from this same
 * array — emitter and running host read one object, so the artifact cannot drift.
 */
export const MODULES = [bookingModule, invoicingModule, rallyModule];

const adminPerms = [
  RP.browse, RP.manageVenue, RP.managePricing, RP.manageMembers,
  BK.create, BK.read, BK.hold, BK.confirm, BK.cancel, BK.move, BK.complete, BK.manageResources,
  INV.read, INV.export,
];

/**
 * This vertical's role table. `booking:manage-resources` and `rally:manage-venue`
 * are deliberately withheld from the receptionist: taking a booking is the job,
 * re-cutting the club's hours or courts is not. `booking:move` IS included —
 * rescheduling a customer is reception work — while `booking:cancel` is too,
 * because in this club refunds are handled at the desk. A club wanting those
 * split has a role edit to make, and the diff will show it.
 */
export const ROLES: RoleDefinition[] = [
  { key: 'club-admin', permissions: adminPerms, source: 'vertical' },
  {
    key: 'receptionist',
    permissions: [
      RP.browse, BK.read, BK.hold, BK.confirm, BK.cancel, BK.move, BK.create, RP.manageMembers,
    ],
    source: 'vertical',
  },
  /**
   * DELIBERATELY BROAD — reviewed and accepted at the permission checkpoint
   * (2026-07-18), see spec/concept.md §9.
   *
   * `booking:read` here is the WHOLE venue calendar: every court, every slot, and
   * the member names against them. It is NOT narrowed to the coach's own lessons.
   * Narrowing needs an entity grant minted per coach at runtime, which is a
   * console concern; at this club's size the staff calendar is shared anyway.
   *
   * The line to re-open this on: a club running independent coaches who must not
   * see each other's business. This role is wrong for them.
   */
  { key: 'coach', permissions: [RP.browse, BK.read], source: 'vertical' },
];

/**
 * A player holds NO ROLE — a consumer is not a principal with a role
 * (kernel-design.md §4.3). They hold two kinds of grant instead, and the split
 * is the whole point:
 *
 * SCOPE-WIDE — capabilities that are genuinely public at a club. Seeing which
 * slots are free, and taking a free one, are things any player may do; there is
 * no narrower entity to hang them on, because the court they want is by
 * definition not yet theirs.
 */
const portalScopePerms = [RP.browse, BK.hold, BK.create];

/**
 * ENTITY-NARROWED to the player's own member record — everything that touches a
 * booking that already exists. `booking:read` scope-wide would hand a player the
 * club's entire book; narrowed, the walk reservation → member reaches only their
 * own. Confirming and cancelling ride the same edge.
 */
const portalEntityPerms = [BK.read, BK.confirm, BK.cancel];

/**
 * Grant SHAPES. The grants themselves are per-principal and minted at runtime, so
 * they can never be a build artifact; their shape can, and it is what tells a
 * reviewer which keys are reachable outside the role table.
 */
export const ENTITY_GRANTS: { entityType: string; permissions: PermissionKey[] }[] = [
  { entityType: 'member', permissions: portalEntityPerms },
  // Not entity-narrowed at all — recorded here so the artifact cannot imply that
  // every non-role capability is entity-bounded. These are scope-wide.
  { entityType: '(scope-wide, no entity)', permissions: portalScopePerms },
];

export function buildRallyHost(dir: string): SqliteScopeHost {
  const host = new SqliteScopeHost({ dir }); // default checker: the tuple engine
  for (const m of MODULES) host.registerModule(m);
  return host;
}

/** Idempotent: safe on every server start; demo data seeds only once. */
export async function seedRally(host: SqliteScopeHost, dir: string): Promise<RallyWorld> {
  const castPath = join(dir, 'cast.json');
  const fresh = !existsSync(castPath);
  const raw: Record<string, string> = fresh
    ? {
        t1: ulid(), t2: ulid(), s1: ulid(), s1b: ulid(), s2: ulid(),
        astrid: ulid(), ravi: ulid(), nils: ulid(), elin: ulid(), johan: ulid(), rutger: ulid(),
        court1: '', court2: '', elinId: '', johanId: '',
        elinParty: ulid(), johanParty: ulid(),
      }
    : (JSON.parse(readFileSync(castPath, 'utf8')) as Record<string, string>);

  const world: RallyWorld = {
    t1: tenantId.parse(raw.t1), t2: tenantId.parse(raw.t2),
    s1: scopeId.parse(raw.s1), s1b: scopeId.parse(raw.s1b), s2: scopeId.parse(raw.s2),
    astrid: principalId.parse(raw.astrid), ravi: principalId.parse(raw.ravi),
    nils: principalId.parse(raw.nils), elin: principalId.parse(raw.elin),
    johan: principalId.parse(raw.johan), rutger: principalId.parse(raw.rutger),
    court1: raw.court1 ?? '', court2: raw.court2 ?? '',
    elinId: raw.elinId ?? '', johanId: raw.johanId ?? '',
    elinParty: raw.elinParty!, johanParty: raw.johanParty!,
  };

  const staff = platformActorId.parse(ulid());

  await host.admin.createTenant(staff, { id: world.t1, slug: 'rallypoint', name: 'RallyPoint AB' });
  await host.admin.createTenant(staff, {
    id: world.t2, slug: 'padelcenter-vast', name: 'Padelcenter Väst AB',
  });

  for (const t of [world.t1, world.t2]) {
    for (const key of ['booking', 'invoicing', 'rallypoint']) {
      await host.admin.grantEntitlement(staff, t, key);
    }
  }

  await host.provisionScope(staff, { tenantId: world.t1, scopeId: world.s1, jurisdiction: 'eu' });
  await host.provisionScope(staff, { tenantId: world.t1, scopeId: world.s1b, jurisdiction: 'eu' });
  await host.provisionScope(staff, { tenantId: world.t2, scopeId: world.s2, jurisdiction: 'eu' });

  for (const t of [world.t1, world.t2]) {
    for (const role of ROLES) await host.admin.defineRole(staff, t, role);
  }
  // Astrid runs both RallyPoint venues (tenant-level); Ravi only Solna — the
  // "role at many-but-not-all scopes" case the kernel acceptance list wants.
  await host.admin.assignRole(staff, {
    principalId: world.astrid, roleKey: 'club-admin', node: { tenantId: world.t1, scopeId: null },
  });
  await host.admin.assignRole(staff, {
    principalId: world.ravi, roleKey: 'receptionist', node: { tenantId: world.t1, scopeId: world.s1 },
  });
  await host.admin.assignRole(staff, {
    principalId: world.nils, roleKey: 'coach', node: { tenantId: world.t1, scopeId: world.s1 },
  });
  await host.admin.assignRole(staff, {
    principalId: world.rutger, roleKey: 'club-admin', node: { tenantId: world.t2, scopeId: null },
  });

  if (fresh) {
    const stub = await host.getScope(world.astrid, world.t1, world.s1);

    await stub.invoke('rally/set-venue', {
      name: 'RallyPoint Solna', timezone: 'Europe/Stockholm', holdMinutes: 10,
    });

    // Mon–Fri 07:00–23:00, weekends 08:00–22:00 (0 = Sunday).
    for (const weekday of [1, 2, 3, 4, 5]) {
      await stub.invoke('rally/set-hours', { weekday, opensAt: '07:00', closesAt: '23:00' });
    }
    for (const weekday of [0, 6]) {
      await stub.invoke('rally/set-hours', { weekday, opensAt: '08:00', closesAt: '22:00' });
    }

    const c1 = await stub.invoke<{ id: string }>('booking/create-resource', {
      kind: 'court', name: 'Bana 1',
    });
    const c2 = await stub.invoke<{ id: string }>('booking/create-resource', {
      kind: 'court', name: 'Bana 2',
    });
    await stub.invoke('rally/register-court', { resourceId: c1.id, durations: '60,90,120' });
    // Bana 2 is 90-only at peak — the "durations vary by court" case.
    await stub.invoke('rally/register-court', { resourceId: c2.id, durations: '60,90' });

    await stub.invoke('rally/upsert-tier', { key: 'drop-in', title: 'Drop-in', discountPct: 0 });
    await stub.invoke('rally/upsert-tier', {
      key: 'member', title: 'Member', discountPct: 10, monthlyAmount: '199',
    });
    await stub.invoke('rally/upsert-tier', {
      key: 'club-plus', title: 'Club+', discountPct: 20, monthlyAmount: '449',
    });

    // Base first, then the narrower peak rule — precedence is most-specific-wins.
    await stub.invoke('rally/upsert-price-rule', { label: 'Base', amount: '260' });
    await stub.invoke('rally/upsert-price-rule', {
      label: 'Peak 17–21', fromTime: '17:00', toTime: '21:00', amount: '340',
    });

    const elin = await stub.invoke<{ id: string }>('rally/create-member', {
      partyRef: world.elinParty, name: 'Elin Kastberg', phone: '070-555 21 09',
      tier: 'member', level: '3.4',
    });
    const johan = await stub.invoke<{ id: string }>('rally/create-member', {
      partyRef: world.johanParty, name: 'Johan Ek', tier: 'drop-in', level: '3.1',
    });

    world.court1 = c1.id;
    world.court2 = c2.id;
    world.elinId = elin.id;
    world.johanId = johan.id;
    writeFileSync(castPath, JSON.stringify(world, null, 2));
  }

  // Portal grants (idempotent): entity-narrowed per member — see ENTITY_GRANTS.
  for (const [principal, memberId] of [
    [world.elin, world.elinId],
    [world.johan, world.johanId],
  ] as const) {
    if (!memberId) continue;
    for (const permission of portalEntityPerms) {
      await host.admin.grant(staff, {
        principalId: principal,
        permission,
        node: { tenantId: world.t1, scopeId: world.s1 },
        entity: { entityType: 'member', entityId: memberId },
        grantedBy: world.astrid,
      });
    }
    for (const permission of portalScopePerms) {
      await host.admin.grant(staff, {
        principalId: principal,
        permission,
        node: { tenantId: world.t1, scopeId: world.s1 },
        grantedBy: world.astrid,
      });
    }
  }

  return world;
}
