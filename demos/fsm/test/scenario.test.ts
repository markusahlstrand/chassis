import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { ScopeStub } from '@substrat/kernel';
import type { WorkOrder, BillableLine } from '@substrat/engine-workorder';
import { buildDemoHost, seedDemo, type DemoWorld } from '../src/index.js';
import type { SqliteScopeHost } from '@substrat/adapter-sqlite';

/**
 * The nine-step scenario from spec/testrun.md §8 — the headless end-to-end
 * run: provision → modules → lifecycle → priced completion → event →
 * invoicing → portal isolation → attack fails → plain .sqlite files.
 */
describe('FSM demo scenario (spec §8)', () => {
  let dir: string;
  let host: SqliteScopeHost;
  let w: DemoWorld;
  let anna: ScopeStub;
  let harald: ScopeStub;
  let orderId: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-fsm-'));
    host = buildDemoHost(dir);
    w = await seedDemo(host, dir);
    anna = await host.getScope(w.anna, w.t1, w.s1);
    harald = await host.getScope(w.harald, w.t1, w.s1);
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('1. provisions and applies all three module journals', () => {
    const db = new Database(join(dir, `${w.t1}__${w.s1}.sqlite`), { readonly: true });
    const rows = db
      .prepare('SELECT DISTINCT module_id FROM _substrat_migrations ORDER BY module_id')
      .all() as { module_id: string }[];
    db.close();
    expect(rows.map((r) => r.module_id)).toEqual([
      '@substrat-demos/fsm',
      '@substrat/engine-invoicing',
      '@substrat/engine-workorder',
    ]);
  });

  it('2–3. anna creates a work order at Förskolan Grunden', async () => {
    const order = await anna.invoke<WorkOrder>('serviceco/create-workorder', {
      facilityId: w.forskolanId,
      kind: 'akut',
      title: 'Droppar vatten från frysen',
    });
    orderId = order.id;
    expect(order.number).toBe(1);
    expect(order.status).toBe('planned');
    expect(order.customer.entityId).toBe(w.grundenId);

    const timeline = await anna.invoke<{ type: string }[]>('serviceco/timeline', {
      entityType: 'workorder',
      entityId: orderId,
    });
    expect(timeline.map((e) => e.type)).toContain('workorder.created');
  });

  it('3. assign → start → report time and material', async () => {
    await anna.invoke('workorder/assign', { orderId, technician: w.harald });
    await harald.invoke('workorder/start', { orderId });
    await harald.invoke('workorder/report-time', { orderId, hours: '1' });
    await harald.invoke('workorder/report-time', { orderId, hours: '0.75' });
    await harald.invoke('workorder/report-material', {
      orderId,
      article: 'mat:fan-motor-15w',
      qty: '1',
    });
    const detail = await harald.invoke<{ order: WorkOrder; time: unknown[]; material: unknown[] }>(
      'workorder/get',
      { orderId },
    );
    expect(detail.order.status).toBe('in_progress');
    expect(detail.time).toHaveLength(2);
    expect(detail.material).toHaveLength(1);
  });

  it('4. the denials hold: technician, portal user, and the cross-tenant attacker', async () => {
    await expect(
      harald.invoke('workorder/assign', { orderId, technician: w.harald }),
    ).rejects.toThrow(/permission denied/);

    // mallory (t2 office-admin) attacks t1's scope. Claiming it under her own
    // tenant fails closed on the pair check (K-3)…
    await expect(host.getScope(w.mallory, w.t2, w.s1)).rejects.toThrow(/unknown scope/);
    // …and with the correct pair she can mint a stub but holds no tuples in
    // t1 — every operation is denied by the owning scope's evaluation.
    const mallory = await host.getScope(w.mallory, w.t1, w.s1);
    await expect(mallory.invoke('workorder/list')).rejects.toThrow(/permission denied/);
    await expect(mallory.invoke('invoicing/list')).rejects.toThrow(/permission denied/);
    await expect(mallory.invoke<unknown[]>('serviceco/portal-orders')).resolves.toEqual([]);

    const berit = await host.getScope(w.berit, w.t1, w.s1);
    await expect(berit.invoke('workorder/report-time', { orderId, hours: '1' })).rejects.toThrow(
      /permission denied/,
    );
  });

  it('5. priced completion: min-qty applied, internal dropped, snapshot math exact', async () => {
    const result = await anna.invoke<{ billable: BillableLine[]; total: { amount: string } }>(
      'serviceco/complete-workorder',
      { orderId },
    );
    // 1.75h reported > 1.5 min → 1.75 × 515 = 901.25; material 1 × 1150.
    expect(result.billable).toHaveLength(2);
    const labor = result.billable.find((b) => b.article === 'labor')!;
    expect(labor.qty).toBe('1.75');
    expect(labor.lineTotal.amount).toBe('901.25');
    expect(result.total.amount).toBe('2051.25');

    // Immutable after completion.
    await expect(
      anna.invoke('workorder/report-time', { orderId, hours: '1' }),
    ).rejects.toThrow(/invalid transition/);
  });

  it('6. star topology observed: the invoicing engine consumed the event', async () => {
    const underlag = await anna.invoke<{ id: string; status: string; total: string }[]>(
      'invoicing/list',
    );
    expect(underlag).toHaveLength(1);
    expect(underlag[0]!.status).toBe('open');
    expect(underlag[0]!.total).toBe('2051.25');

    const detail = await anna.invoke<{ lines: { source_id: string; source_type: string }[] }>(
      'invoicing/get',
      { underlagId: underlag[0]!.id },
    );
    expect(detail.lines).toHaveLength(2);
    expect(detail.lines.every((l) => l.source_type === 'workorder' && l.source_id === orderId)).toBe(
      true,
    );
  });

  it('7. portal isolation: berit sees her order, styrbjörn sees nothing, invoicing denied', async () => {
    const berit = await host.getScope(w.berit, w.t1, w.s1);
    const styrbjorn = await host.getScope(w.styrbjorn, w.t1, w.s1);

    const berits = await berit.invoke<WorkOrder[]>('serviceco/portal-orders');
    expect(berits.map((o) => o.id)).toEqual([orderId]);

    await expect(styrbjorn.invoke<WorkOrder[]>('serviceco/portal-orders')).resolves.toEqual([]);
    await expect(berit.invoke('invoicing/list')).rejects.toThrow(/permission denied/);

    // berit can read her order's timeline through the same entity walk.
    const timeline = await berit.invoke<{ type: string }[]>('serviceco/timeline', {
      entityType: 'workorder',
      entityId: orderId,
    });
    expect(timeline.length).toBeGreaterThan(3);
  });

  it('8. export makes the underlag immutable; the next completion opens a new one', async () => {
    const [underlag] = await anna.invoke<{ id: string }[]>('invoicing/list');
    await anna.invoke('invoicing/export', { underlagId: underlag!.id });
    await expect(anna.invoke('invoicing/export', { underlagId: underlag!.id })).rejects.toThrow(
      /immutable/,
    );

    const order2 = await anna.invoke<WorkOrder>('serviceco/create-workorder', {
      facilityId: w.forskolanId,
      kind: 'service',
      title: 'Filterbyte',
    });
    await anna.invoke('workorder/start', { orderId: order2.id });
    await anna.invoke('workorder/report-time', { orderId: order2.id, hours: '1' });
    await anna.invoke('serviceco/complete-workorder', { orderId: order2.id });

    const all = await anna.invoke<{ status: string }[]>('invoicing/list');
    expect(all).toHaveLength(2);
    expect(all.filter((u) => u.status === 'open')).toHaveLength(1);
    expect(all.filter((u) => u.status === 'exported')).toHaveLength(1);
  });

  it('9. close completes the state machine', async () => {
    const closed = await anna.invoke<WorkOrder>('workorder/close', { orderId });
    expect(closed.status).toBe('closed');
    // planned → closed skip is impossible: close on the OPEN second order fails.
    const open = (await anna.invoke<WorkOrder[]>('workorder/list', { status: 'completed' }))[0]!;
    await anna.invoke('workorder/close', { orderId: open.id });
    const order3 = await anna.invoke<WorkOrder>('serviceco/create-workorder', {
      facilityId: w.kontorId,
      kind: 'service',
      title: 'Ny belysning',
    });
    await expect(anna.invoke('workorder/close', { orderId: order3.id })).rejects.toThrow(
      /invalid transition/,
    );
  });
});
