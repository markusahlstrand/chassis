import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { ScopeStub } from '@substrat-run/kernel';
import type { WorkOrder, BillableLine } from '@substrat-run/engine-workorder';
import {
  buildBikeShopHost,
  protocolContentHash,
  seedBikeShop,
  type BikeShopWorld,
  type ProtocolDetail,
  type ProtocolInstanceRow,
  type ProtocolSignatureRow,
} from '../src/index.js';
import type { SqliteScopeHost } from '@substrat-run/adapter-sqlite';

/**
 * The CykelService scenario (spec/concept.md §7) — the same engines as
 * ServiceCo, replayed with bike-shop vocabulary: provision → modules →
 * repair lifecycle → priced completion (the MINIMUM-billing branch) →
 * event → invoicing → portal isolation → attack fails → state machine holds.
 * Then the milestone-B beat (steps 10–11, engine-protocol.md §2): the
 * tillståndsrapport — filled at intake/during the repair, signed by the
 * workshop, COUNTER-SIGNED by the customer on the frozen content at pickup —
 * running on the extracted protocol engine.
 */
describe('CykelService demo scenario (spec §7)', () => {
  let dir: string;
  let host: SqliteScopeHost;
  let w: BikeShopWorld;
  let greta: ScopeStub;
  let mans: ScopeStub;
  let repairId: string;
  let serviceRepairId: string;
  let reportId: string;

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

  it('1. provisions and applies all four module journals', () => {
    const db = new Database(join(dir, `${w.t1}__${w.s1}.sqlite`), { readonly: true });
    const rows = db
      .prepare('SELECT DISTINCT module_id FROM _substrat_migrations ORDER BY module_id')
      .all() as { module_id: string }[];
    db.close();
    expect(rows.map((r) => r.module_id)).toEqual([
      '@substrat-run/demo-bike-shop',
      '@substrat-run/engine-invoicing',
      '@substrat-run/engine-protocol',
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

  it('10. the condition report: opened at intake, filled append-only, fill/sign split holds', async () => {
    const repair = await greta.invoke<WorkOrder>('bike-shop/create-repair', {
      bikeId: w.crescentId,
      kind: 'service',
      title: 'Vårservice — full genomgång',
    });
    serviceRepairId = repair.id;

    // Intake: the condition report opens on the repair (vertical policy:
    // only while the repair is open; the engine pins the template version).
    const report = await greta.invoke<ProtocolInstanceRow>('bike-shop/start-condition-report', {
      orderId: serviceRepairId,
    });
    reportId = report.id;
    expect(report.status).toBe('open');
    expect(report.template_key).toBe('tillstandsrapport');
    expect(report.template_version).toBe(1);
    await expect(
      greta.invoke('bike-shop/start-condition-report', { orderId: serviceRepairId }),
    ).rejects.toThrow(/already open/);

    await greta.invoke('workorder/assign', { orderId: serviceRepairId, technician: w.mans });
    await mans.invoke('workorder/start', { orderId: serviceRepairId });

    // The mechanic fills; a correction is a NEW row (append-only history).
    await mans.invoke('protocol/fill', {
      instanceId: reportId,
      itemKey: 'ramskador',
      value: 'Lackskada vänster kedjestag (befintlig)',
    });
    await mans.invoke('protocol/fill', {
      instanceId: reportId,
      itemKey: 'ramskador',
      value: 'Lackskada vänster kedjestag (befintlig), repa på styret',
      note: 'såg repan vid tvätt',
    });
    await mans.invoke('protocol/fill', { instanceId: reportId, itemKey: 'belysning-fungerar', value: true });
    await mans.invoke('protocol/fill', { instanceId: reportId, itemKey: 'bromsar-ok', value: true });
    await mans.invoke('protocol/fill', { instanceId: reportId, itemKey: 'vaxlar-ok', value: true });
    await mans.invoke('protocol/fill', { instanceId: reportId, itemKey: 'provkord', value: true });

    const detail = await mans.invoke<ProtocolDetail>('protocol/get', { instanceId: reportId });
    expect(detail.responses).toHaveLength(6); // full history kept
    expect(detail.responses.filter((r) => r.item_key === 'ramskador')).toHaveLength(2);
    expect(JSON.parse(detail.latest['ramskador']!.value_json)).toMatch(/repa på styret/);

    // Counter-signing needs FROZEN content: before the workshop signs, even
    // the entitled customer is refused by the engine invariant.
    const lisbeth = await host.getScope(w.lisbeth, w.t1, w.s1);
    await expect(lisbeth.invoke('protocol/countersign', { instanceId: reportId })).rejects.toThrow(
      /only a signed \(frozen\) protocol/,
    );
    // The mechanic fills; only the verkstadschef signs (permission split).
    await expect(mans.invoke('protocol/sign', { instanceId: reportId })).rejects.toThrow(
      /permission denied/,
    );
  });

  it('11. sign freezes; the customer counter-signs the SAME frozen content at pickup', async () => {
    const signed = await greta.invoke<{
      instance: ProtocolInstanceRow;
      signature: ProtocolSignatureRow;
    }>('protocol/sign', { instanceId: reportId });
    expect(signed.instance.status).toBe('signed');
    expect(signed.signature.kind).toBe('primary');
    expect(signed.signature.content_hash).toMatch(/^[0-9a-f]{64}$/);

    // Frozen means frozen — for everyone, including the workshop.
    await expect(
      mans.invoke('protocol/fill', { instanceId: reportId, itemKey: 'anmarkningar', value: 'glömde' }),
    ).rejects.toThrow(/frozen/);

    // Priced completion happens before pickup; the report stays frozen through it.
    await mans.invoke('workorder/report-time', { orderId: serviceRepairId, hours: '1' });
    await greta.invoke('bike-shop/complete-repair', { orderId: serviceRepairId });

    // Pickup. The counter-signature is the CUSTOMER's act: no role carries
    // protocol:countersign — not even the verkstadschef…
    await expect(greta.invoke('protocol/countersign', { instanceId: reportId })).rejects.toThrow(
      /permission denied/,
    );
    // …and the WRONG customer's walk (protocol → workorder → bike → customer)
    // ends at Lisbeth's customer node, not Otto's.
    const otto = await host.getScope(w.otto, w.t1, w.s1);
    await expect(otto.invoke('protocol/countersign', { instanceId: reportId })).rejects.toThrow(
      /permission denied/,
    );

    // Lisbeth counter-signs: a SECOND signature row on the same frozen
    // content — the engine replays the hash recipe and must land on the
    // primary signature's hash before the row is written.
    const lisbeth = await host.getScope(w.lisbeth, w.t1, w.s1);
    const counter = await lisbeth.invoke<{
      instance: ProtocolInstanceRow;
      signature: ProtocolSignatureRow;
    }>('protocol/countersign', { instanceId: reportId });
    expect(counter.instance.status).toBe('signed'); // counter-sign is not a state change
    expect(counter.signature.kind).toBe('counter');
    expect(counter.signature.signed_by).toBe(w.lisbeth);
    expect(counter.signature.content_hash).toBe(signed.signature.content_hash);

    // Once is enough.
    await expect(lisbeth.invoke('protocol/countersign', { instanceId: reportId })).rejects.toThrow(
      /already counter-signed/,
    );

    // The customer can read the document she counter-signed (per-entity walk)
    // and anyone can replay the hash against stored state.
    const detail = await lisbeth.invoke<ProtocolDetail>('protocol/get', { instanceId: reportId });
    expect(detail.signatures.map((s) => s.kind)).toEqual(['primary', 'counter']);
    const replayed = await protocolContentHash(
      {
        key: detail.template.key,
        version: detail.template.version,
        content_json: JSON.stringify(detail.template.content),
      },
      detail.latest,
    );
    expect(replayed).toBe(signed.signature.content_hash);

    // Every mutation hit the spine, counter-signature included.
    const timeline = await greta.invoke<{ type: string }[]>('bike-shop/timeline', {
      entityType: 'protocol',
      entityId: reportId,
    });
    expect(timeline.map((e) => e.type)).toEqual([
      'protocol.instantiated',
      'protocol.response-recorded',
      'protocol.response-recorded',
      'protocol.response-recorded',
      'protocol.response-recorded',
      'protocol.response-recorded',
      'protocol.response-recorded',
      'protocol.signed',
      'protocol.countersigned',
    ]);

    // The bike goes home.
    const closed = await greta.invoke<WorkOrder>('workorder/close', { orderId: serviceRepairId });
    expect(closed.status).toBe('closed');
  });
});
