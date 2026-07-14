import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { ScopeStub } from '@substrat-run/kernel';
import type { WorkOrder, BillableLine } from '@substrat-run/engine-workorder';
import { buildBikeShopHost, seedBikeShop, type BikeShopWorld } from '../src/index.js';
import type { SqliteScopeHost } from '@substrat-run/adapter-sqlite';

/**
 * The CykelService scenario (spec/concept.md §7) — the same engines as
 * ServiceCo, replayed with bike-shop vocabulary: provision → modules →
 * repair lifecycle → priced completion (the MINIMUM-billing branch) →
 * event → invoicing → portal isolation → attack fails → state machine holds.
 */
describe('CykelService demo scenario (spec §7)', () => {
  let dir: string;
  let host: SqliteScopeHost;
  let w: BikeShopWorld;
  let greta: ScopeStub;
  let mans: ScopeStub;
  let repairId: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-bike-shop-'));
    host = buildBikeShopHost(dir);
    w = await seedBikeShop(host, dir);
    greta = await host.getScope(w.greta, w.t1, w.s1);
    mans = await host.getScope(w.mans, w.t1, w.s1);
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
      '@substrat-run/demo-bike-shop',
      '@substrat-run/engine-invoicing',
      '@substrat-run/engine-workorder',
    ]);
  });

  it("2. greta registers a repair for Lisbeth's Crescent", async () => {
    const repair = await greta.invoke<WorkOrder>('bike-shop/create-repair', {
      bikeId: w.crescentId,
      kind: 'punktering',
      title: 'Punktering bakhjul, växlar hoppar',
    });
    repairId = repair.id;
    expect(repair.number).toBe(1);
    expect(repair.status).toBe('planned');
    expect(repair.facility).toEqual({ entityType: 'bike', entityId: w.crescentId });
    expect(repair.customer.entityId).toBe(w.lisbethId);

    const timeline = await greta.invoke<{ type: string }[]>('bike-shop/timeline', {
      entityType: 'workorder',
      entityId: repairId,
    });
    expect(timeline.map((e) => e.type)).toContain('workorder.created');
  });

  it('3. assign → start → report time and parts', async () => {
    await greta.invoke('workorder/assign', { orderId: repairId, technician: w.mans });
    await mans.invoke('workorder/start', { orderId: repairId });
    await mans.invoke('workorder/report-time', { orderId: repairId, hours: '0.25' });
    await mans.invoke('workorder/report-material', {
      orderId: repairId,
      article: 'sb:innerslang-28',
      qty: '1',
    });
    await mans.invoke('workorder/report-material', {
      orderId: repairId,
      article: 'verkstadsmtrl',
      qty: '1',
    });
    const detail = await mans.invoke<{ order: WorkOrder; time: unknown[]; material: unknown[] }>(
      'workorder/get',
      { orderId: repairId },
    );
    expect(detail.order.status).toBe('in_progress');
    expect(detail.time).toHaveLength(1);
    expect(detail.material).toHaveLength(2);
  });

  it('4. the denials hold: mechanic, portal user, and the cross-tenant attacker', async () => {
    await expect(
      mans.invoke('workorder/assign', { orderId: repairId, technician: w.mans }),
    ).rejects.toThrow(/permission denied/);

    // rutger (t2 workshop-admin) attacks t1's scope. Claiming it under his own
    // tenant fails closed on the pair check (K-3)…
    await expect(host.getScope(w.rutger, w.t2, w.s1)).rejects.toThrow(/unknown scope/);
    // …and with the correct pair he can mint a stub but holds no tuples in
    // t1 — every operation is denied by the owning scope's evaluation.
    const rutger = await host.getScope(w.rutger, w.t1, w.s1);
    await expect(rutger.invoke('workorder/list')).rejects.toThrow(/permission denied/);
    await expect(rutger.invoke('bike-shop/list-customers')).rejects.toThrow(/permission denied/);
    await expect(rutger.invoke('invoicing/list')).rejects.toThrow(/permission denied/);
    await expect(rutger.invoke<unknown[]>('bike-shop/portal-repairs')).resolves.toEqual([]);

    const lisbeth = await host.getScope(w.lisbeth, w.t1, w.s1);
    await expect(
      lisbeth.invoke('workorder/report-time', { orderId: repairId, hours: '1' }),
    ).rejects.toThrow(/permission denied/);
  });

  it('5. priced completion: the half-hour minimum bills, internal dropped, math exact', async () => {
    const result = await greta.invoke<{ billable: BillableLine[]; total: { amount: string } }>(
      'bike-shop/complete-repair',
      { orderId: repairId },
    );
    // 0.25h reported < 0.5 min → bill the minimum: 0.5 × 495 = 247.5.
    // Parts: 1 × 89 (innerslang); verkstadsmtrl is internal and dropped.
    expect(result.billable).toHaveLength(2);
    const labor = result.billable.find((b) => b.article === 'labor')!;
    expect(labor.qty).toBe('0.5');
    expect(labor.lineTotal.amount).toBe('247.5');
    const slang = result.billable.find((b) => b.article === 'sb:innerslang-28')!;
    expect(slang.lineTotal.amount).toBe('89');
    expect(result.total.amount).toBe('336.5');

    // Immutable after completion.
    await expect(
      greta.invoke('workorder/report-time', { orderId: repairId, hours: '1' }),
    ).rejects.toThrow(/invalid transition/);
  });

  it('6. star topology observed: the invoicing engine consumed the event', async () => {
    const underlag = await greta.invoke<{ id: string; status: string; total: string }[]>(
      'invoicing/list',
    );
    expect(underlag).toHaveLength(1);
    expect(underlag[0]!.status).toBe('open');
    expect(underlag[0]!.total).toBe('336.5');

    const detail = await greta.invoke<{ lines: { source_id: string; source_type: string }[] }>(
      'invoicing/get',
      { underlagId: underlag[0]!.id },
    );
    expect(detail.lines).toHaveLength(2);
    expect(
      detail.lines.every((l) => l.source_type === 'workorder' && l.source_id === repairId),
    ).toBe(true);
  });

  it('7. portal isolation: lisbeth sees her repair, otto sees nothing, invoicing denied', async () => {
    const lisbeth = await host.getScope(w.lisbeth, w.t1, w.s1);
    const otto = await host.getScope(w.otto, w.t1, w.s1);

    const hers = await lisbeth.invoke<WorkOrder[]>('bike-shop/portal-repairs');
    expect(hers.map((o) => o.id)).toEqual([repairId]);

    await expect(otto.invoke<WorkOrder[]>('bike-shop/portal-repairs')).resolves.toEqual([]);
    await expect(lisbeth.invoke('invoicing/list')).rejects.toThrow(/permission denied/);

    // lisbeth can read her repair's timeline through the same entity walk
    // (workorder → bike → customer).
    const timeline = await lisbeth.invoke<{ type: string }[]>('bike-shop/timeline', {
      entityType: 'workorder',
      entityId: repairId,
    });
    expect(timeline.length).toBeGreaterThan(3);
  });

  it('8. export makes the underlag immutable; the next completion opens a new one', async () => {
    const [underlag] = await greta.invoke<{ id: string }[]>('invoicing/list');
    await greta.invoke('invoicing/export', { underlagId: underlag!.id });
    await expect(greta.invoke('invoicing/export', { underlagId: underlag!.id })).rejects.toThrow(
      /immutable/,
    );

    const repair2 = await greta.invoke<WorkOrder>('bike-shop/create-repair', {
      bikeId: w.crescentId,
      kind: 'service',
      title: 'Årsservice, byta kedja',
    });
    await greta.invoke('workorder/start', { orderId: repair2.id });
    await greta.invoke('workorder/report-time', { orderId: repair2.id, hours: '1' });
    await greta.invoke('workorder/report-material', {
      orderId: repair2.id,
      article: 'sb:kedja-9v',
      qty: '1',
    });
    await greta.invoke('bike-shop/complete-repair', { orderId: repair2.id });

    const all = await greta.invoke<{ status: string; total: string }[]>('invoicing/list');
    expect(all).toHaveLength(2);
    expect(all.filter((u) => u.status === 'open')).toHaveLength(1);
    expect(all.filter((u) => u.status === 'exported')).toHaveLength(1);
    // 1h ≥ 0.5 min → 1 × 495 + kedja 249 = 744.
    expect(all.find((u) => u.status === 'open')!.total).toBe('744');
  });

  it('9. close completes the state machine; planned → closed skip is impossible', async () => {
    const closed = await greta.invoke<WorkOrder>('workorder/close', { orderId: repairId });
    expect(closed.status).toBe('closed');
    const open = (await greta.invoke<WorkOrder[]>('workorder/list', { status: 'completed' }))[0]!;
    await greta.invoke('workorder/close', { orderId: open.id });
    const repair3 = await greta.invoke<WorkOrder>('bike-shop/create-repair', {
      bikeId: w.bianchiId,
      kind: 'service',
      title: 'Justera bromsar',
    });
    await expect(greta.invoke('workorder/close', { orderId: repair3.id })).rejects.toThrow(
      /invalid transition/,
    );
  });
});
