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
import { protocolModule, PROTOCOL_PERM as PROTO } from '@substrat-run/engine-protocol';
import { meridianModule, HR_PERM } from './module.js';

/**
 * Meridian demo world (spec/concept.md §3): one multi-country company
 * (Nordljus AB, SE + ES scopes) and a second company (Solmark AB) that owns the
 * cross-tenant attack victim. Employees are entity-narrowed principals, not a
 * role — their access is a grant on their OWN employee record, exactly like the
 * Callout portal customer.
 */
/**
 * What ANY instance of this vertical has: one tenant, one scope, an owner.
 *
 * The boundary #31 blocker 3 is about — everything in DemoWorld beyond these three
 * is the DEMO STORY, which a customer must not receive. Separate types make that
 * structural: `provisionMeridian` cannot return a cast, because its return type has no
 * room for one.
 */
export interface MeridianInstance {
  tenantId: TenantId;
  scopeId: ScopeId;
  /** The first hr-admin — whoever provisioned it. */
  owner: PrincipalId;
}

/** The demo world: an instance, plus the cast and fixtures the story needs. */
export interface DemoWorld extends MeridianInstance {
  t1: TenantId; // Nordljus AB
  t2: TenantId; // Solmark AB (attack victim owner)
  sSe: ScopeId; // Nordljus — Sweden (Stockholm)
  sEs: ScopeId; // Nordljus — Spain (Madrid)
  s2: ScopeId; // Solmark — Sweden
  hedda: PrincipalId; // HR admin, t1 tenant-level (sees both countries)
  mats: PrincipalId; // manager @ sSe
  elin: PrincipalId; // employee @ sSe (entity-narrowed to her own record)
  pablo: PrincipalId; // employee @ sEs
  petra: PrincipalId; // payroll operator @ sSe
  mallory: PrincipalId; // HR admin @ t2 — the attacker
  elinEmpId?: string; // Elin's employee record (sSe)
  karinEmpId?: string; // a second SE employee, no login (directory + denial target)
  matsEmpId?: string; // Mats' own employee record — he is ALSO an employee (dual role)
  pabloEmpId?: string; // Pablo's employee record (sEs)
  projectId?: string; // 'nordljus-app' project (sSe)
}

/**
 * Registration order = migration order. The protocol engine registers before
 * the vertical so its tables exist for onboarding. Exported for the permission
 * checkpoint emitter (parity with demos/callout).
 */
export const MODULES = [protocolModule, meridianModule];

const hrAdminPerms: PermissionKey[] = [
  HR_PERM.employeeManage,
  HR_PERM.absenceConfigure,
  HR_PERM.absenceApprove,
  HR_PERM.absenceRead,
  HR_PERM.timeRead,
  HR_PERM.projectManage,
  HR_PERM.expenseApprove,
  HR_PERM.expenseRead,
  HR_PERM.payrollExport,
  PROTO.create,
  PROTO.fill,
  PROTO.sign,
  PROTO.read,
  PROTO.void,
];

const managerPerms: PermissionKey[] = [
  HR_PERM.absenceApprove,
  HR_PERM.absenceRead,
  HR_PERM.timeRead,
  HR_PERM.expenseApprove,
  HR_PERM.expenseRead,
  PROTO.read,
];

const payrollPerms: PermissionKey[] = [HR_PERM.payrollExport, HR_PERM.expenseRead];

/**
 * This vertical's role table — identical in every tenant, so a plain constant.
 * Employees are NOT a role: their access is entity-narrowed (see EMPLOYEE_SELF).
 */
export const ROLES: RoleDefinition[] = [
  { key: 'hr-admin', permissions: hrAdminPerms, source: 'vertical' },
  { key: 'manager', permissions: managerPerms, source: 'vertical' },
  { key: 'payroll', permissions: payrollPerms, source: 'vertical' },
];

/**
 * What an employee receives, narrowed to their own employee record. Note
 * PROTO.sign: onboarding is *employee-signed* here (they e-sign their own
 * acknowledgements) — vertical policy that differs from Callout, where the
 * arbetsledare signs. Same engine, different who-signs; the grant draws the line.
 */
const EMPLOYEE_SELF: PermissionKey[] = [
  HR_PERM.absenceRead,
  HR_PERM.absenceRequest,
  HR_PERM.timeReport,
  HR_PERM.timeRead,
  HR_PERM.expenseSubmit,
  HR_PERM.expenseRead,
  PROTO.fill,
  PROTO.sign,
  PROTO.read,
];

/** Entity-narrowed grant SHAPES — the reviewable half of the permission diff. */
export const ENTITY_GRANTS: { entityType: string; permissions: PermissionKey[] }[] = [
  { entityType: 'employee', permissions: EMPLOYEE_SELF },
];

export function buildDemoHost(dir: string): SqliteScopeHost {
  const host = new SqliteScopeHost({ dir });
  for (const m of MODULES) host.registerModule(m);
  return host;
}

const ONBOARDING_SE = {
  key: 'onboarding-se',
  title: 'Onboarding — Sverige',
  content: {
    sections: [
      {
        title: 'Första dagen',
        items: [
          { key: 'anstallningsavtal', label: 'Anställningsavtal signerat', type: 'check' as const },
          { key: 'utrustning', label: 'Dator och passerkort utlämnade', type: 'check' as const },
          { key: 'bankuppgifter', label: 'Bankuppgifter för lön registrerade', type: 'check' as const },
        ],
      },
    ],
  },
};

const ONBOARDING_ES = {
  key: 'onboarding-es',
  title: 'Onboarding — España',
  content: {
    sections: [
      {
        title: 'Primer día',
        items: [
          { key: 'contrato', label: 'Contrato firmado', type: 'check' as const },
          { key: 'equipo', label: 'Equipo y tarjeta de acceso entregados', type: 'check' as const },
          { key: 'registro_jornada', label: 'Registro de jornada explicado', type: 'check' as const },
        ],
      },
    ],
  },
};

/** Idempotent: safe on every start; demo data seeds only once. */
/**
 * Provision ONE instance of this vertical — what a customer gets (#31 blocker 3).
 *
 * Tenant, scope, entitlements, roles, identity pool, and an owner holding
 * `hr-admin`. No cast, no fixtures, no second company. Idempotent, so it is
 * safe on every start and safe against an instance that already exists.
 *
 * This is the function an instantiate button calls.
 */
export async function provisionMeridian(
  host: SqliteScopeHost,
  input: { tenantId: TenantId; scopeId: ScopeId; owner: PrincipalId; slug: string; name: string },
): Promise<MeridianInstance> {
  const staff = platformActorId.parse(ulid());

  await host.admin.createTenant(staff, { id: input.tenantId, slug: input.slug, name: input.name });
  // K-23: a provider declares its topology before it may link an identity.
  await host.admin.registerIdentityPool(staff, {
    provider: 'better-auth',
    topology: 'central',
    tenantId: null,
  });
  // Entitlements (§4.3) are default-deny, so the SKU flags for the modules this
  // vertical runs must be granted before any of its operations resolve.
  for (const key of ['protocol', 'meridian']) {
    await host.admin.grantEntitlement(staff, input.tenantId, key);
  }
  await host.provisionScope(staff, {
    tenantId: input.tenantId,
    scopeId: input.scopeId,
    jurisdiction: 'eu',
  });
  // Provisioning writes the row as `provisioning`; nothing may use the scope until
  // it is active (K-31). Here the platform and the vertical are the same process, so
  // the confirmation is immediate — hosted, it arrives from the vertical over a
  // separate call, which is the gap the state exists to make observable.
  await host.admin.activateScope(staff, input.tenantId, input.scopeId);
  for (const role of ROLES) await host.admin.defineRole(staff, input.tenantId, role);
  await host.admin.assignRole(staff, {
    principalId: input.owner,
    roleKey: 'hr-admin',
    node: { tenantId: input.tenantId, scopeId: null },
  });

  return { tenantId: input.tenantId, scopeId: input.scopeId, owner: input.owner };
}

export async function seedDemo(host: SqliteScopeHost, dir: string): Promise<DemoWorld> {
  const castPath = join(dir, 'cast.json');
  const fresh = !existsSync(castPath);
  const raw: Record<string, string> = fresh
    ? {
        t1: ulid(), t2: ulid(), sSe: ulid(), sEs: ulid(), s2: ulid(),
        hedda: ulid(), mats: ulid(), elin: ulid(), pablo: ulid(), petra: ulid(), mallory: ulid(),
        elinEmpId: '', karinEmpId: '', matsEmpId: '', pabloEmpId: '', projectId: '',
      }
    : (JSON.parse(readFileSync(castPath, 'utf8')) as Record<string, string>);

  const world: DemoWorld = {
    tenantId: tenantId.parse(raw.t1),
    scopeId: scopeId.parse(raw.sSe),
    owner: principalId.parse(raw.hedda),
    t1: tenantId.parse(raw.t1), t2: tenantId.parse(raw.t2),
    sSe: scopeId.parse(raw.sSe), sEs: scopeId.parse(raw.sEs), s2: scopeId.parse(raw.s2),
    hedda: principalId.parse(raw.hedda), mats: principalId.parse(raw.mats),
    elin: principalId.parse(raw.elin), pablo: principalId.parse(raw.pablo),
    petra: principalId.parse(raw.petra), mallory: principalId.parse(raw.mallory),
    elinEmpId: raw.elinEmpId ?? '', karinEmpId: raw.karinEmpId ?? '',
    matsEmpId: raw.matsEmpId ?? '', pabloEmpId: raw.pabloEmpId ?? '', projectId: raw.projectId ?? '',
  };

  const staff = platformActorId.parse(ulid());

  // The real instance — everything a customer would get, and nothing else.
  await provisionMeridian(host, {
    tenantId: world.t1, scopeId: world.sSe, owner: world.hedda,
    slug: 'nordljus', name: 'Nordljus AB',
  });
  // A second scope in the SAME tenant — one company, two countries. Provisioning
  // creates one scope because that is what an instance needs; more are the
  // customer's to add.
  await host.provisionScope(staff, { tenantId: world.t1, scopeId: world.sEs, kind: 'entity', name: 'Spain', jurisdiction: 'eu' });
  await host.admin.activateScope(staff, world.t1, world.sEs);

  // ---------------------------------------------------------------------------
  // DEMO ONLY, below. A second company and an admin nobody hired, so the scenario
  // can watch the tenant boundary turn them away (#31 blocker 4). Never reachable
  // from provisioning — instantiating the template would otherwise hand a
  // customer a company they do not own with an account they did not create.
  // ---------------------------------------------------------------------------
  await provisionMeridian(host, {
    tenantId: world.t2, scopeId: world.s2, owner: world.mallory,
    slug: 'solmark', name: 'Solmark AB',
  });

  // The demo cast's remaining roles; the tenant-level admins came from provisioning.
  await host.admin.assignRole(staff, { principalId: world.mats, roleKey: 'manager', node: { tenantId: world.t1, scopeId: world.sSe } });
  await host.admin.assignRole(staff, { principalId: world.petra, roleKey: 'payroll', node: { tenantId: world.t1, scopeId: world.sSe } });

  if (fresh) {
    // --- Sweden (Stockholm) ---
    const se = await host.getScope(world.hedda, world.t1, world.sSe);
    await se.invoke('hr/define-leave-type', { key: 'vacation', label: 'Semester', kind: 'vacation', annualDays: '25' });
    await se.invoke('hr/define-leave-type', { key: 'vab', label: 'Vård av barn', kind: 'vab' });
    await se.invoke('hr/define-leave-type', { key: 'sick', label: 'Sjukfrånvaro', kind: 'sick' });
    const elinEmp = await se.invoke<{ id: string }>('hr/create-employee', {
      number: 'SE-001', name: 'Elin Ek', email: 'elin@nordljus.se', nationalId: '19900101-0000', principalRef: world.elin, startedAt: '2024-01-15',
    });
    const karinEmp = await se.invoke<{ id: string }>('hr/create-employee', {
      number: 'SE-002', name: 'Karin Berg', email: 'karin@nordljus.se',
    });
    // Mats is a team lead: a manager (role, above) who is ALSO an employee with
    // his own balance and timesheet — the persona that shows My Work + Manage.
    const matsEmp = await se.invoke<{ id: string }>('hr/create-employee', {
      number: 'SE-003', name: 'Mats Lund', email: 'mats@nordljus.se', principalRef: world.mats, startedAt: '2022-09-01',
    });
    await se.invoke('hr/accrue', { employeeId: elinEmp.id, leaveTypeKey: 'vacation', days: '25' });
    await se.invoke('hr/accrue', { employeeId: matsEmp.id, leaveTypeKey: 'vacation', days: '25' });
    const project = await se.invoke<{ id: string }>('hr/create-project', { code: 'nordljus-app', name: 'Nordljus App' });
    await se.invoke('hr/create-project', { code: 'internal', name: 'Internal' });
    await se.invoke('protocol/define-template', ONBOARDING_SE);
    // Elin is a new hire: start her onboarding checklist so the app opens on the
    // new-hire state. She fills and e-signs it herself through her own grant.
    await se.invoke('hr/start-onboarding', { templateKey: 'onboarding-se', employeeId: elinEmp.id });

    // --- Spain (Madrid): different statutory rules, same code ---
    const es = await host.getScope(world.hedda, world.t1, world.sEs);
    await es.invoke('hr/define-leave-type', { key: 'vacation', label: 'Vacaciones', kind: 'vacation', annualDays: '22' });
    await es.invoke('hr/define-leave-type', { key: 'baja', label: 'Baja médica', kind: 'sick' });
    const pabloEmp = await es.invoke<{ id: string }>('hr/create-employee', {
      number: 'ES-001', name: 'Pablo Ruiz', email: 'pablo@nordljus.es', nationalId: '00000000-A', principalRef: world.pablo, startedAt: '2024-03-01',
    });
    await es.invoke('hr/accrue', { employeeId: pabloEmp.id, leaveTypeKey: 'vacation', days: '22' });
    await es.invoke('protocol/define-template', ONBOARDING_ES);

    world.elinEmpId = elinEmp.id;
    world.karinEmpId = karinEmp.id;
    world.matsEmpId = matsEmp.id;
    world.pabloEmpId = pabloEmp.id;
    world.projectId = project.id;
    writeFileSync(castPath, JSON.stringify(world, null, 2));
  }

  // Employee self-service grants (idempotent), entity-narrowed to own record.
  for (const [principal, empId, scope] of [
    [world.elin, world.elinEmpId, world.sSe],
    [world.mats, world.matsEmpId, world.sSe],
    [world.pablo, world.pabloEmpId, world.sEs],
  ] as const) {
    if (!empId) continue;
    for (const permission of EMPLOYEE_SELF) {
      await host.admin.grant(staff, {
        principalId: principal,
        permission,
        node: { tenantId: world.t1, scopeId: scope },
        entity: { entityType: 'employee', entityId: empId },
        grantedBy: world.hedda,
      });
    }
  }

  return world;
}
