import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { ScopeStub } from '@substrat-run/kernel';
import type { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import type { ProtocolInstanceRow } from '@substrat-run/engine-protocol';
import {
  buildDemoHost,
  seedDemo,
  type DemoWorld,
  type EmployeeRow,
  type ExpenseRow,
  type LeaveRequestRow,
  type LedgerRow,
  type TimeEntryRow,
} from '../src/index.js';

/**
 * The Meridian scenario (spec/concept.md §9): provision → two country scopes →
 * request/approve leave that folds the append-only ledger → denials hold
 * (self-service isolation + cross-tenant attack) → the no-negative floor and
 * approval state machine → time reporting → expenses → payroll export →
 * onboarding via the protocol engine → country divergence.
 */
describe('Meridian (HR) demo scenario (spec §9)', () => {
  let dir: string;
  let host: SqliteScopeHost;
  let w: DemoWorld;
  let hedda: ScopeStub; // HR admin (tenant-level)
  let mats: ScopeStub; // manager @ sSe
  let elin: ScopeStub; // employee @ sSe
  let petra: ScopeStub; // payroll @ sSe

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-hr-'));
    host = buildDemoHost(dir);
    w = await seedDemo(host, dir);
    hedda = await host.getScope(w.hedda, w.t1, w.sSe);
    mats = await host.getScope(w.mats, w.t1, w.sSe);
    elin = await host.getScope(w.elin, w.t1, w.sSe);
    petra = await host.getScope(w.petra, w.t1, w.sSe);
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('1. provisions and applies both module journals', () => {
    const db = new Database(join(dir, `${w.t1}__${w.sSe}.sqlite`), { readonly: true });
    const rows = db
      .prepare('SELECT DISTINCT module_id FROM _substrat_migrations ORDER BY module_id')
      .all() as { module_id: string }[];
    db.close();
    expect(rows.map((r) => r.module_id)).toEqual([
      '@substrat-run/demo-meridian',
      '@substrat-run/engine-protocol',
    ]);
  });

  it('2. the directory and starting balance are seeded', async () => {
    const employees = await hedda.invoke<EmployeeRow[]>('hr/list-employees');
    expect(employees.map((e) => e.number)).toEqual(['SE-001', 'SE-002', 'SE-003']);
    const bal = await hedda.invoke<{ balances: { leaveTypeKey: string; balance: string }[] }>(
      'hr/balance',
      { employeeId: w.elinEmpId },
    );
    expect(bal.balances).toEqual([{ leaveTypeKey: 'vacation', balance: '25' }]);
  });

  it('3. elin requests 5 days; mats approves; the ledger folds to 20', async () => {
    const req = await elin.invoke<LeaveRequestRow>('hr/request-leave', {
      employeeId: w.elinEmpId,
      leaveTypeKey: 'vacation',
      startDate: '2026-07-06',
      endDate: '2026-07-10',
      days: '5',
    });
    expect(req.status).toBe('requested');

    const decided = await mats.invoke<{ request: LeaveRequestRow; booking: LedgerRow }>(
      'hr/decide-leave',
      { requestId: req.id, decision: 'approve' },
    );
    expect(decided.request.status).toBe('approved');
    expect(decided.booking.delta).toBe('-5');

    const bal = await elin.invoke<{ balances: { balance: string }[] }>('hr/balance', {
      employeeId: w.elinEmpId,
    });
    expect(bal.balances[0]!.balance).toBe('20');

    // Append-only: accrual + booking, never an edit.
    const ledger = await hedda.invoke<{ balances: unknown[] }>('hr/balance', { employeeId: w.elinEmpId });
    expect(ledger.balances).toHaveLength(1);
  });

  it('4. the denials hold: self-service isolation and the cross-tenant attack', async () => {
    // elin cannot approve her own leave (no absence:approve anywhere).
    const openReq = await elin.invoke<LeaveRequestRow>('hr/request-leave', {
      employeeId: w.elinEmpId, leaveTypeKey: 'vacation', startDate: '2026-08-01', endDate: '2026-08-01', days: '1',
    });
    await expect(
      elin.invoke('hr/decide-leave', { requestId: openReq.id, decision: 'approve' }),
    ).rejects.toThrow(/permission denied/);

    // elin cannot read a colleague's balance (grant is narrowed to her record).
    await expect(elin.invoke('hr/balance', { employeeId: w.karinEmpId })).rejects.toThrow(
      /permission denied/,
    );
    // …nor request leave on someone else's behalf.
    await expect(
      elin.invoke('hr/request-leave', {
        employeeId: w.karinEmpId, leaveTypeKey: 'vacation', startDate: '2026-08-01', endDate: '2026-08-01', days: '1',
      }),
    ).rejects.toThrow(/permission denied/);
    // …nor read the directory (no employee:manage).
    await expect(elin.invoke('hr/list-employees')).rejects.toThrow(/permission denied/);

    // mallory (t2 HR admin) attacks t1's Sweden scope. Wrong pair fails closed…
    await expect(host.getScope(w.mallory, w.t2, w.sSe)).rejects.toThrow(/unknown scope/);
    // …and with the correct pair she holds no tuples in t1 — every op denied.
    const mallory = await host.getScope(w.mallory, w.t1, w.sSe);
    await expect(mallory.invoke('hr/list-employees')).rejects.toThrow(/permission denied/);
    await expect(mallory.invoke('hr/balance', { employeeId: w.elinEmpId })).rejects.toThrow(
      /permission denied/,
    );
  });

  it('5. the no-negative floor and the approval state machine both hold', async () => {
    // Elin has 20 left; a 30-day request approved must fail on the floor.
    const tooBig = await elin.invoke<LeaveRequestRow>('hr/request-leave', {
      employeeId: w.elinEmpId, leaveTypeKey: 'vacation', startDate: '2026-09-01', endDate: '2026-09-30', days: '30',
    });
    await expect(
      mats.invoke('hr/decide-leave', { requestId: tooBig.id, decision: 'approve' }),
    ).rejects.toThrow(/insufficient balance/);
    // Reject it, then a second decision on the same request is impossible.
    await mats.invoke('hr/decide-leave', { requestId: tooBig.id, decision: 'reject' });
    await expect(
      mats.invoke('hr/decide-leave', { requestId: tooBig.id, decision: 'approve' }),
    ).rejects.toThrow(/only a requested leave can be decided/);
    // The failed approval wrote nothing: balance untouched.
    const bal = await hedda.invoke<{ balances: { balance: string }[] }>('hr/balance', {
      employeeId: w.elinEmpId,
    });
    expect(bal.balances[0]!.balance).toBe('20');
  });

  it('6. time reporting is append-only; the daily total is a fold', async () => {
    await elin.invoke('hr/log-time', { employeeId: w.elinEmpId, projectId: w.projectId, workDate: '2026-07-13', hours: '8' });
    // A correction is a NEW row, never an edit.
    await elin.invoke('hr/log-time', { employeeId: w.elinEmpId, projectId: w.projectId, workDate: '2026-07-14', hours: '7.5' });
    const sheet = await elin.invoke<{ entries: TimeEntryRow[]; totalHours: string }>('hr/timesheet', {
      employeeId: w.elinEmpId,
    });
    expect(sheet.entries).toHaveLength(2);
    expect(sheet.totalHours).toBe('15.5');
  });

  it('7. expenses: submit → approve → payroll export marks them exported', async () => {
    const exp = await elin.invoke<ExpenseRow>('hr/submit-expense', {
      employeeId: w.elinEmpId, description: 'Tågbiljett Stockholm–Göteborg', amount: '640', currency: 'SEK', category: 'travel', projectId: w.projectId,
    });
    expect(exp.status).toBe('submitted');
    // elin cannot approve her own expense.
    await expect(
      elin.invoke('hr/decide-expense', { expenseId: exp.id, decision: 'approve' }),
    ).rejects.toThrow(/permission denied/);
    await mats.invoke('hr/decide-expense', { expenseId: exp.id, decision: 'approve' });

    const run = await petra.invoke<{ expenses: { amount: string }[]; absence: { days: string }[] }>(
      'hr/payroll-export',
      { fromDate: '2026-07-01', toDate: '2026-07-31' },
    );
    expect(run.expenses).toEqual([{ employeeId: w.elinEmpId, amount: '640', currency: 'SEK', category: 'travel' }]);
    // The July booking (5 days) shows up as positive days in the export.
    expect(run.absence).toEqual([{ employeeId: w.elinEmpId, leaveTypeKey: 'vacation', days: '5' }]);

    // Re-running the export never double-counts: the expense is now 'exported'.
    const again = await petra.invoke<{ expenses: unknown[] }>('hr/payroll-export', {
      fromDate: '2026-07-01', toDate: '2026-07-31',
    });
    expect(again.expenses).toHaveLength(0);
  });

  it('8. onboarding reuses the protocol engine: the employee fills AND e-signs their own', async () => {
    // Seeded as an open onboarding for Elin; she reaches it via her own-record
    // grant walking protocol → employee.
    const summaries = await elin.invoke<{ instance: ProtocolInstanceRow }[]>('protocol/list-for-entity', {
      entityType: 'employee',
      entityId: w.elinEmpId,
    });
    const inst = summaries[0]!.instance;
    expect(inst.status).toBe('open');
    expect(inst.entity_type).toBe('employee');

    await elin.invoke('protocol/fill', { instanceId: inst.id, itemKey: 'anstallningsavtal', value: true });
    // Vertical policy: the EMPLOYEE signs their own onboarding (unlike Callout,
    // where the arbetsledare signs) — same engine, the grant draws the line.
    const signed = await elin.invoke<{ instance: ProtocolInstanceRow }>('protocol/sign', {
      instanceId: inst.id,
    });
    expect(signed.instance.status).toBe('signed');
    // Frozen: a further fill fails.
    await expect(
      elin.invoke('protocol/fill', { instanceId: inst.id, itemKey: 'utrustning', value: true }),
    ).rejects.toThrow(/frozen/);
    // A colleague (the manager) holds no fill on Elin's onboarding.
    await expect(
      mats.invoke('protocol/fill', { instanceId: inst.id, itemKey: 'utrustning', value: true }),
    ).rejects.toThrow(/permission denied/);
  });

  it('9. country divergence: Spain runs the same code with different statutory rules', async () => {
    const es = await host.getScope(w.hedda, w.t1, w.sEs);
    const types = await es.invoke<{ key: string; annual_days: string | null }[]>('hr/list-leave-types');
    const vacation = types.find((t) => t.key === 'vacation')!;
    expect(vacation.annual_days).toBe('22'); // Spain, not Sweden's 25
    const bal = await es.invoke<{ balances: { balance: string }[] }>('hr/balance', {
      employeeId: w.pabloEmpId,
    });
    expect(bal.balances[0]!.balance).toBe('22');

    // Scope isolation: the Stockholm manager has no reach into Madrid.
    const matsInEs = await host.getScope(w.mats, w.t1, w.sEs);
    await expect(matsInEs.invoke('hr/list-requests')).rejects.toThrow(/permission denied/);
  });
});
