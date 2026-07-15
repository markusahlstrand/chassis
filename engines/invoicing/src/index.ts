import { z } from 'zod';
import {
  addDecimal,
  entityRef,
  money,
  moduleManifest,
  permissionKey,
} from '@substrat-run/contracts';
import {
  assertAllowed,
  ulid,
  type ConsumerHandler,
  type ModuleRegistration,
  type OperationContext,
  type OperationHandler,
} from '@substrat-run/kernel';

// ============================================================================
// The invoicing engine (demos/fsm/spec/testrun.md §4.3/§5.3). Consumes
// `workorder.completed` — snapshot, not join: prices and quantities are frozen
// from the event payload, provenance kept as EntityRef columns. Zero imports
// from the workorder engine (star topology, D-19).
// ============================================================================

export const INVOICING_PERM = {
  read: permissionKey.parse('invoicing:read'),
  export: permissionKey.parse('invoicing:export'),
};

export const invoicingManifest = moduleManifest.parse({
  id: '@substrat-run/engine-invoicing',
  version: '0.0.1',
  kernelContract: '^0.0.1',
  permissions: [
    { key: 'invoicing:read', description: 'Read fakturaunderlag' },
    { key: 'invoicing:export', description: 'Export a fakturaunderlag (makes it immutable)' },
  ],
  events: {
    emits: [
      { type: 'invoicing.underlag-updated', schemaVersion: 1 },
      { type: 'invoicing.underlag-exported', schemaVersion: 1 },
    ],
    consumes: [
      { type: 'workorder.completed', schemaVersion: 1 },
      { type: 'commerce.order-placed', schemaVersion: 1 },
    ],
  },
  migrations: { journalDir: './migrations', compatibleFrom: '0.0.1' },
  attachmentTargets: [{ entityType: 'underlag', readPermission: 'invoicing:read' }],
  entitlementKey: 'invoicing',
  ui: {
    routes: [{ path: 'invoicing', screen: './ui/UnderlagList', permission: 'invoicing:read' }],
    nav: [{ label: 'invoicing.nav', icon: 'receipt', to: 'invoicing', permission: 'invoicing:read' }],
    entityViews: [{ entityType: 'underlag', view: './ui/UnderlagCard' }],
  },
});

export const invoicingMigrations = [
  {
    version: '0001-init',
    sql: `
      CREATE TABLE invoicing_underlag (
        id            TEXT PRIMARY KEY,
        number        INTEGER NOT NULL UNIQUE,
        customer_type TEXT NOT NULL,
        customer_id   TEXT NOT NULL,
        status        TEXT NOT NULL CHECK (status IN ('open','exported')),
        created_at    TEXT NOT NULL,
        exported_at   TEXT
      );
      CREATE TABLE invoicing_lines (
        id                TEXT PRIMARY KEY,
        underlag_id       TEXT NOT NULL REFERENCES invoicing_underlag(id),
        source_type       TEXT NOT NULL,
        source_id         TEXT NOT NULL,
        article           TEXT NOT NULL,
        description       TEXT NOT NULL,
        qty               TEXT NOT NULL,
        unit              TEXT NOT NULL,
        unit_price_amount TEXT NOT NULL,
        currency          TEXT NOT NULL,
        line_total_amount TEXT NOT NULL,
        created_at        TEXT NOT NULL
      );
    `,
  },
];

// What this engine needs from the fat event payload — its OWN parse of the
// contract; it never imports the producer's types.
const completedPayload = z.object({
  orderId: z.string().min(1),
  number: z.number().int(),
  customer: entityRef,
  billable: z.array(
    z.object({
      article: z.string().min(1),
      description: z.string().min(1),
      qty: z.string().min(1),
      unit: z.string().min(1),
      unitPrice: money,
      lineTotal: money,
      sourceType: z.enum(['time', 'material']),
      sourceId: z.string().min(1),
    }),
  ),
  total: money,
});

// ADDITIVE (D-28): a SECOND input event. The engine learns to build a
// fakturaunderlag from a retail order without touching the workorder path — new
// `consumes` entry + this parse + the consumer below, no migration, no
// permission. Its OWN Zod view of the contract; zero imports from the producer.
const commercePlacedPayload = z.object({
  orderId: z.string().min(1),
  number: z.number().int(),
  customer: entityRef,
  paymentMethod: z.string().min(1),
  billable: z.array(
    z.object({
      article: z.string().min(1),
      description: z.string().min(1),
      qty: z.string().min(1),
      unit: z.string().min(1),
      unitPrice: money,
      lineTotal: money,
    }),
  ),
  total: money,
});

export interface UnderlagRow {
  id: string;
  number: number;
  customer_type: string;
  customer_id: string;
  status: 'open' | 'exported';
  created_at: string;
  exported_at: string | null;
}

export interface UnderlagLine {
  id: string;
  underlag_id: string;
  source_type: string;
  source_id: string;
  article: string;
  description: string;
  qty: string;
  unit: string;
  unit_price_amount: string;
  currency: string;
  line_total_amount: string;
  created_at: string;
}

function underlagTotal(ctx: OperationContext, underlagId: string): string {
  return ctx.sql
    .query<{ line_total_amount: string }>(
      'SELECT line_total_amount FROM invoicing_lines WHERE underlag_id = ?',
      [underlagId],
    )
    .reduce((sum, r) => addDecimal(sum, r.line_total_amount), '0');
}

const onWorkOrderCompleted: ConsumerHandler = (ctx, event) => {
  const p = completedPayload.parse(event.payload);
  if (p.billable.length === 0) return;

  // Find-or-create the OPEN underlag for this customer; an exported underlag
  // is immutable — late deliveries open a new one (engine invariant on top of
  // the kernel's delivery journal).
  let underlag = ctx.sql.query<UnderlagRow>(
    `SELECT * FROM invoicing_underlag WHERE customer_type = ? AND customer_id = ? AND status = 'open'`,
    [p.customer.entityType, p.customer.entityId],
  )[0];
  if (!underlag) {
    const id = ulid();
    const number =
      ctx.sql.query<{ n: number }>(
        'SELECT COALESCE(MAX(number), 0) + 1 AS n FROM invoicing_underlag',
      )[0]?.n ?? 1;
    ctx.sql.exec(
      `INSERT INTO invoicing_underlag (id, number, customer_type, customer_id, status, created_at)
       VALUES (?, ?, ?, ?, 'open', ?)`,
      [id, number, p.customer.entityType, p.customer.entityId, new Date().toISOString()],
    );
    underlag = ctx.sql.query<UnderlagRow>('SELECT * FROM invoicing_underlag WHERE id = ?', [id])[0]!;
  }

  for (const line of p.billable) {
    ctx.sql.exec(
      `INSERT INTO invoicing_lines
         (id, underlag_id, source_type, source_id, article, description, qty, unit,
          unit_price_amount, currency, line_total_amount, created_at)
       VALUES (?, ?, 'workorder', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        ulid(),
        underlag.id,
        p.orderId,
        line.article,
        line.description,
        line.qty,
        line.unit,
        line.unitPrice.amount,
        line.unitPrice.currency,
        line.lineTotal.amount,
        new Date().toISOString(),
      ],
    );
  }

  ctx.emit({
    type: 'invoicing.underlag-updated',
    schemaVersion: 1,
    entity: { entityType: 'underlag', entityId: underlag.id },
    piiClass: 'none',
    payload: {
      underlagId: underlag.id,
      addedLines: p.billable.length,
      source: { entityType: 'workorder', entityId: p.orderId },
    },
  });
};

// ADDITIVE consumer for the retail order event (concept §7). Same snapshot,
// -not-join discipline as `onWorkOrderCompleted`; source_type is 'order'. Only
// invoice-payment orders bill — card/Swish settle through a payment connector.
const onCommerceOrderPlaced: ConsumerHandler = (ctx, event) => {
  const p = commercePlacedPayload.parse(event.payload);
  if (p.paymentMethod !== 'invoice') return;
  if (p.billable.length === 0) return;

  // Idempotent on at-least-once redelivery (K-11): the order is the dedup key.
  // Its lines are already present → this delivery is a replay, do nothing.
  const already = ctx.sql.query<{ found: number }>(
    `SELECT 1 AS found FROM invoicing_lines WHERE source_type = 'order' AND source_id = ? LIMIT 1`,
    [p.orderId],
  )[0];
  if (already) return;

  let underlag = ctx.sql.query<UnderlagRow>(
    `SELECT * FROM invoicing_underlag WHERE customer_type = ? AND customer_id = ? AND status = 'open'`,
    [p.customer.entityType, p.customer.entityId],
  )[0];
  if (!underlag) {
    const id = ulid();
    const number =
      ctx.sql.query<{ n: number }>(
        'SELECT COALESCE(MAX(number), 0) + 1 AS n FROM invoicing_underlag',
      )[0]?.n ?? 1;
    ctx.sql.exec(
      `INSERT INTO invoicing_underlag (id, number, customer_type, customer_id, status, created_at)
       VALUES (?, ?, ?, ?, 'open', ?)`,
      [id, number, p.customer.entityType, p.customer.entityId, new Date().toISOString()],
    );
    underlag = ctx.sql.query<UnderlagRow>('SELECT * FROM invoicing_underlag WHERE id = ?', [id])[0]!;
  }

  for (const line of p.billable) {
    ctx.sql.exec(
      `INSERT INTO invoicing_lines
         (id, underlag_id, source_type, source_id, article, description, qty, unit,
          unit_price_amount, currency, line_total_amount, created_at)
       VALUES (?, ?, 'order', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        ulid(),
        underlag.id,
        p.orderId,
        line.article,
        line.description,
        line.qty,
        line.unit,
        line.unitPrice.amount,
        line.unitPrice.currency,
        line.lineTotal.amount,
        new Date().toISOString(),
      ],
    );
  }

  ctx.emit({
    type: 'invoicing.underlag-updated',
    schemaVersion: 1,
    entity: { entityType: 'underlag', entityId: underlag.id },
    piiClass: 'none',
    payload: {
      underlagId: underlag.id,
      addedLines: p.billable.length,
      source: { entityType: 'order', entityId: p.orderId },
    },
  });
};

const listOp: OperationHandler<
  { status?: string } | undefined,
  (UnderlagRow & { total: string })[]
> = async (ctx, input) => {
  assertAllowed(await ctx.check(INVOICING_PERM.read));
  const rows = input?.status
    ? ctx.sql.query<UnderlagRow>(
        'SELECT * FROM invoicing_underlag WHERE status = ? ORDER BY number DESC',
        [input.status],
      )
    : ctx.sql.query<UnderlagRow>('SELECT * FROM invoicing_underlag ORDER BY number DESC');
  return rows.map((r) => ({ ...r, total: underlagTotal(ctx, r.id) }));
};

const getOp: OperationHandler<
  { underlagId: string },
  { underlag: UnderlagRow; lines: UnderlagLine[]; total: string }
> = async (ctx, input) => {
  assertAllowed(await ctx.check(INVOICING_PERM.read));
  const underlag = ctx.sql.query<UnderlagRow>('SELECT * FROM invoicing_underlag WHERE id = ?', [
    input.underlagId,
  ])[0];
  if (!underlag) throw new Error(`underlag not found: ${input.underlagId}`);
  const lines = ctx.sql.query<UnderlagLine>(
    'SELECT * FROM invoicing_lines WHERE underlag_id = ? ORDER BY id',
    [input.underlagId],
  );
  return { underlag, lines, total: underlagTotal(ctx, input.underlagId) };
};

const exportOp: OperationHandler<{ underlagId: string }, UnderlagRow> = async (ctx, input) => {
  assertAllowed(await ctx.check(INVOICING_PERM.export));
  const underlag = ctx.sql.query<UnderlagRow>('SELECT * FROM invoicing_underlag WHERE id = ?', [
    input.underlagId,
  ])[0];
  if (!underlag) throw new Error(`underlag not found: ${input.underlagId}`);
  if (underlag.status !== 'open') {
    throw new Error(`underlag ${underlag.number} is '${underlag.status}' — exported underlag are immutable`);
  }
  ctx.sql.exec(
    `UPDATE invoicing_underlag SET status = 'exported', exported_at = ? WHERE id = ?`,
    [new Date().toISOString(), underlag.id],
  );
  ctx.emit({
    type: 'invoicing.underlag-exported',
    schemaVersion: 1,
    entity: { entityType: 'underlag', entityId: underlag.id },
    piiClass: 'none',
    payload: {
      underlagId: underlag.id,
      number: underlag.number,
      total: underlagTotal(ctx, underlag.id),
    },
  });
  return ctx.sql.query<UnderlagRow>('SELECT * FROM invoicing_underlag WHERE id = ?', [
    underlag.id,
  ])[0]!;
};

export const invoicingModule: ModuleRegistration = {
  manifest: invoicingManifest,
  migrations: invoicingMigrations,
  operations: {
    'invoicing/list': listOp as never,
    'invoicing/get': getOp as never,
    'invoicing/export': exportOp as never,
  },
  consumers: {
    'workorder.completed': onWorkOrderCompleted,
    'commerce.order-placed': onCommerceOrderPlaced,
  },
};
