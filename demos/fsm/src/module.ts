import { z } from 'zod';
import {
  compareDecimal,
  addDecimal,
  moduleManifest,
  moneyOf,
  mulMoney,
  permissionKey,
  type EntityRef,
  type Money,
} from '@substrat-run/contracts';
import {
  assertAllowed,
  ulid,
  type ModuleRegistration,
  type OperationContext,
  type OperationHandler,
} from '@substrat-run/kernel';
import {
  completeWorkOrder,
  createWorkOrder,
  getReportedLines,
  listOrders,
  PERM as WO,
  type BillableLine,
  type WorkOrder,
} from '@substrat-run/engine-workorder';
import {
  instantiateProtocol,
  requireSigned,
  PROTOCOL_PERM as PROTO,
  type ProtocolInstanceRow,
} from '@substrat-run/engine-protocol';

// ============================================================================
// The ServiceCo vertical (spec/testrun.md §5.1): customers, facilities, the
// price list, and the ORCHESTRATION — including the pricing moment, which is
// vertical logic composed with engine functions in one transaction (K-16).
// ============================================================================

export const SC_PERM = {
  customerManage: permissionKey.parse('customer:manage'),
  facilityManage: permissionKey.parse('facility:manage'),
};

export const servicecoManifest = moduleManifest.parse({
  id: '@substrat-run/demo-fsm',
  version: '0.0.1',
  kernelContract: '^0.0.1',
  permissions: [
    { key: 'customer:manage', description: 'Manage customers and the price list' },
    { key: 'facility:manage', description: 'Manage facilities' },
  ],
  // protocol:* permissions and protocol.* events moved to
  // @substrat-run/engine-protocol at milestone B (engine-protocol.md §2).
  events: { emits: [], consumes: [] },
  migrations: { journalDir: './migrations', compatibleFrom: '0.0.1' },
  attachmentTargets: [
    { entityType: 'customer', readPermission: 'customer:manage' },
    { entityType: 'facility', readPermission: 'facility:manage' },
  ],
  entityRelations: [
    { entityType: 'facility', parentType: 'customer' },
    // The protocol engine is entity-agnostic; THIS vertical hangs protocols
    // off work orders, so it declares the permission-walk edge.
    { entityType: 'protocol', parentType: 'workorder' },
  ],
  entitlementKey: 'serviceco',
});

export const servicecoMigrations = [
  {
    version: '0001-init',
    sql: `
      CREATE TABLE serviceco_customers (
        id          TEXT PRIMARY KEY,
        number      TEXT NOT NULL UNIQUE,
        name        TEXT NOT NULL,
        org_ref     TEXT,
        created_at  TEXT NOT NULL
      );
      CREATE TABLE serviceco_facilities (
        id          TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL REFERENCES serviceco_customers(id),
        name        TEXT NOT NULL,
        address     TEXT,
        access_note TEXT,
        created_at  TEXT NOT NULL
      );
      CREATE TABLE serviceco_price_list (
        article      TEXT PRIMARY KEY,
        description  TEXT NOT NULL,
        unit         TEXT NOT NULL,
        price_amount TEXT NOT NULL,
        currency     TEXT NOT NULL DEFAULT 'SEK',
        min_qty      TEXT,
        internal     INTEGER NOT NULL DEFAULT 0
      );
    `,
  },
  // 0002-protocols shipped at milestone A when protocols were VERTICAL code
  // (engine-protocol.md §2). The journal is append-only: this version stays
  // verbatim forever, even though the tables it creates are legacy since 0003.
  {
    version: '0002-protocols',
    sql: `
    CREATE TABLE serviceco_protocol_templates (
      id           TEXT PRIMARY KEY,
      key          TEXT NOT NULL,
      version      INTEGER NOT NULL,
      title        TEXT NOT NULL,
      content_json TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      UNIQUE (key, version)
    );
    CREATE TABLE serviceco_protocol_instances (
      id               TEXT PRIMARY KEY,
      template_key     TEXT NOT NULL,
      template_version INTEGER NOT NULL,
      entity_type      TEXT NOT NULL,
      entity_id        TEXT NOT NULL,
      status           TEXT NOT NULL CHECK (status IN ('open','signed','voided')),
      created_by       TEXT NOT NULL,
      created_at       TEXT NOT NULL,
      voided_by        TEXT,
      voided_reason    TEXT,
      voided_at        TEXT
    );
    CREATE TABLE serviceco_protocol_responses (
      id           TEXT PRIMARY KEY,
      instance_id  TEXT NOT NULL REFERENCES serviceco_protocol_instances(id),
      item_key     TEXT NOT NULL,
      value_json   TEXT NOT NULL,
      note         TEXT,
      responded_by TEXT NOT NULL,
      responded_at TEXT NOT NULL
    );
    CREATE TABLE serviceco_protocol_signatures (
      id           TEXT PRIMARY KEY,
      instance_id  TEXT NOT NULL REFERENCES serviceco_protocol_instances(id),
      signed_by    TEXT NOT NULL,
      method       TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      evidence_ref TEXT,
      signed_at    TEXT NOT NULL
    );
  `,
  },
  // 0003 — MILESTONE B, the extraction's migration consequence (human
  // checkpoint material): protocol data moves from the vertical's milestone-A
  // tables into the engine's tables, then the legacy tables are dropped.
  // Signed documents keep their ids, hashes and timestamps — the content_hash
  // recipe is unchanged, so every existing signature stays verifiable.
  // ORDERING CONTRACT: @substrat-run/engine-protocol must be registered on
  // the host BEFORE this module so its 0001-init (which creates protocol_*)
  // is journaled first; a wrong order fails closed at migration time.
  // On fresh scopes 0002 + 0003 replay as create-copy-nothing-drop — the
  // honest cost of an append-only journal.
  // boundary-lint-allow R5 — extraction handoff (decision 27): the one-time move
  // of milestone-A data into the engine's tables; the only sanctioned write to
  // another module's schema.
  {
    version: '0003-protocols-to-engine',
    sql: `
    INSERT INTO protocol_templates (id, key, version, title, content_json, created_at)
      SELECT id, key, version, title, content_json, created_at
      FROM serviceco_protocol_templates;
    INSERT INTO protocol_instances
      (id, template_key, template_version, entity_type, entity_id, status,
       created_by, created_at, voided_by, voided_reason, voided_at)
      SELECT id, template_key, template_version, entity_type, entity_id, status,
             created_by, created_at, voided_by, voided_reason, voided_at
      FROM serviceco_protocol_instances;
    INSERT INTO protocol_responses
      (id, instance_id, item_key, value_json, note, responded_by, responded_at)
      SELECT id, instance_id, item_key, value_json, note, responded_by, responded_at
      FROM serviceco_protocol_responses;
    INSERT INTO protocol_signatures
      (id, instance_id, signed_by, kind, method, content_hash, evidence_ref, signed_at)
      SELECT id, instance_id, signed_by, 'primary', method, content_hash, evidence_ref, signed_at
      FROM serviceco_protocol_signatures;
    DROP TABLE serviceco_protocol_signatures;
    DROP TABLE serviceco_protocol_responses;
    DROP TABLE serviceco_protocol_instances;
    DROP TABLE serviceco_protocol_templates;
  `,
  },
  // boundary-lint-end R5
];

export interface CustomerRow {
  id: string;
  number: string;
  name: string;
  org_ref: string | null;
  created_at: string;
}

export interface FacilityRow {
  id: string;
  customer_id: string;
  name: string;
  address: string | null;
  access_note: string | null;
  created_at: string;
}

export interface PriceRow {
  article: string;
  description: string;
  unit: string;
  price_amount: string;
  currency: string;
  min_qty: string | null;
  internal: number;
}

const createCustomerOp: OperationHandler<
  { number: string; name: string; orgRef?: string },
  CustomerRow
> = async (ctx, input) => {
  assertAllowed(await ctx.check(SC_PERM.customerManage));
  const id = ulid();
  ctx.sql.exec(
    `INSERT INTO serviceco_customers (id, number, name, org_ref, created_at) VALUES (?, ?, ?, ?, ?)`,
    [id, input.number, input.name, input.orgRef ?? null, new Date().toISOString()],
  );
  return ctx.sql.query<CustomerRow>('SELECT * FROM serviceco_customers WHERE id = ?', [id])[0]!;
};

const listCustomersOp: OperationHandler<
  undefined,
  (CustomerRow & { facilities: FacilityRow[] })[]
> = async (ctx) => {
  assertAllowed(await ctx.check(SC_PERM.customerManage));
  const customers = ctx.sql.query<CustomerRow>(
    'SELECT * FROM serviceco_customers ORDER BY number',
  );
  return customers.map((c) => ({
    ...c,
    facilities: ctx.sql.query<FacilityRow>(
      'SELECT * FROM serviceco_facilities WHERE customer_id = ? ORDER BY name',
      [c.id],
    ),
  }));
};

const createFacilityOp: OperationHandler<
  { customerId: string; name: string; address?: string; accessNote?: string },
  FacilityRow
> = async (ctx, input) => {
  assertAllowed(await ctx.check(SC_PERM.facilityManage));
  const customer = ctx.sql.query<CustomerRow>('SELECT * FROM serviceco_customers WHERE id = ?', [
    input.customerId,
  ])[0];
  if (!customer) throw new Error(`customer not found: ${input.customerId}`);
  const id = ulid();
  ctx.sql.exec(
    `INSERT INTO serviceco_facilities (id, customer_id, name, address, access_note, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, customer.id, input.name, input.address ?? null, input.accessNote ?? null, new Date().toISOString()],
  );
  ctx.link({ entityType: 'facility', entityId: id }, { entityType: 'customer', entityId: customer.id });
  return ctx.sql.query<FacilityRow>('SELECT * FROM serviceco_facilities WHERE id = ?', [id])[0]!;
};

const upsertPriceOp: OperationHandler<
  {
    article: string;
    description: string;
    unit: string;
    priceAmount: string;
    currency?: string;
    minQty?: string;
    internal?: boolean;
  },
  PriceRow
> = async (ctx, input) => {
  assertAllowed(await ctx.check(SC_PERM.customerManage));
  ctx.sql.exec(
    `INSERT OR REPLACE INTO serviceco_price_list
       (article, description, unit, price_amount, currency, min_qty, internal)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      input.article,
      input.description,
      input.unit,
      input.priceAmount,
      input.currency ?? 'SEK',
      input.minQty ?? null,
      input.internal ? 1 : 0,
    ],
  );
  return ctx.sql.query<PriceRow>('SELECT * FROM serviceco_price_list WHERE article = ?', [
    input.article,
  ])[0]!;
};

const priceListOp: OperationHandler<undefined, PriceRow[]> = async (ctx) => {
  assertAllowed(await ctx.check(SC_PERM.customerManage));
  return ctx.sql.query<PriceRow>('SELECT * FROM serviceco_price_list ORDER BY article');
};

const createWorkOrderOp: OperationHandler<
  { facilityId: string; kind: string; title: string; description?: string },
  WorkOrder
> = async (ctx, input) => {
  assertAllowed(await ctx.check(WO.create));
  const facility = ctx.sql.query<FacilityRow>('SELECT * FROM serviceco_facilities WHERE id = ?', [
    input.facilityId,
  ])[0];
  if (!facility) throw new Error(`facility not found: ${input.facilityId}`);
  return createWorkOrder(ctx, {
    facility: { entityType: 'facility', entityId: facility.id },
    customer: { entityType: 'customer', entityId: facility.customer_id },
    kind: input.kind,
    title: input.title,
    ...(input.description !== undefined ? { description: input.description } : {}),
  });
};

/**
 * ServiceCo compliance policy ("obligatorisk för status"): which order kinds
 * demand a signed protocol before the engine's complete may run. Vertical
 * vocabulary on both axes — kinds AND template keys are ServiceCo content.
 */
const REQUIRED_SIGNED_PROTOCOLS: Record<string, string[]> = {
  montage: ['egenkontroll-el'],
};

/**
 * THE PRICING MOMENT (spec §5.1): reads the engine's reported lines, prices
 * them from the vertical's price list (min-qty applied, internal articles
 * dropped), then calls the engine's complete — one transaction, engine
 * invariant intact, pricing 100% vertical-owned.
 */
const completeWorkOrderOp: OperationHandler<
  { orderId: string },
  { order: WorkOrder; billable: BillableLine[]; total: Money }
> = async (ctx, input) => {
  assertAllowed(await ctx.check(WO.complete));

  // THE GUARD, vertical-composed pole (engine-protocol.md §6, open question 11):
  // predicate before the engine transition, same transaction. This glue IS the
  // compliance gate — removing it is human-checkpoint material, not a refactor.
  //
  // It stays glue ON PURPOSE, and is the contrast that defines the other pole.
  // Milestone C added MANIFEST-declared guards (`guards: [{ before, predicate,
  // config }]`, see demos/bike-shop) — but those are UNCONDITIONAL gates on an
  // operation. This one is conditional on VERTICAL DATA: only `montage` orders
  // owe an egenkontroll, and `order.kind` is ServiceCo vocabulary the kernel
  // must never learn. Conditional-on-vertical-data policy is composed here;
  // unconditional gates are declared in the manifest.
  const order = listOrders(ctx).find((o) => o.id === input.orderId);
  if (!order) throw new Error(`work order not found: ${input.orderId}`);
  for (const templateKey of REQUIRED_SIGNED_PROTOCOLS[order.kind] ?? []) {
    requireSigned(ctx, { entityType: 'workorder', entityId: order.id }, templateKey);
  }

  const reported = getReportedLines(ctx, input.orderId);
  const prices = new Map<string, PriceRow>(
    ctx.sql
      .query<PriceRow>('SELECT * FROM serviceco_price_list')
      .map((p) => [p.article, p]),
  );

  const billable: BillableLine[] = [];

  // Labor: aggregate reported hours, apply minimum billable quantity.
  const laborPrice = prices.get('labor');
  const reportedHours = reported.time.reduce((sum, t) => addDecimal(sum, t.hours), '0');
  if (laborPrice && compareDecimal(reportedHours, '0') > 0) {
    const minQty = laborPrice.min_qty ?? '0';
    const qty = compareDecimal(reportedHours, minQty) >= 0 ? reportedHours : minQty;
    const unitPrice = moneyOf(laborPrice.price_amount, laborPrice.currency);
    billable.push({
      article: 'labor',
      description: laborPrice.description,
      qty,
      unit: laborPrice.unit,
      unitPrice,
      lineTotal: mulMoney(qty, unitPrice),
      sourceType: 'time',
      sourceId: input.orderId,
    });
  }

  // Material: one billable line per reported line; internal articles dropped.
  for (const m of reported.material) {
    const price = prices.get(m.article);
    if (!price) throw new Error(`no price for article: ${m.article}`);
    if (price.internal) continue;
    const unitPrice = moneyOf(price.price_amount, price.currency);
    billable.push({
      article: m.article,
      description: price.description,
      qty: m.qty,
      unit: price.unit,
      unitPrice,
      lineTotal: mulMoney(m.qty, unitPrice),
      sourceType: 'material',
      sourceId: m.id,
    });
  }

  const result = completeWorkOrder(ctx, { orderId: input.orderId, billable });
  return { order: result.order, billable, total: result.total };
};

/**
 * Starting an egenkontroll is engine mechanics + VERTICAL policy: ServiceCo
 * attaches protocols to work orders still being worked. The invariants
 * (version pinning, one open instance, events) live in the engine's in-scope
 * function, composed here in the same transaction (K-16). Fill/sign/void/read
 * carry no ServiceCo policy — the engine's default `protocol/*` bindings are
 * used directly, exactly like `workorder/assign`.
 */
const instantiateProtocolInput = z.object({
  templateKey: z.string().min(1),
  entityType: z.literal('workorder'), // ServiceCo policy: protocols live on work orders
  entityId: z.string().min(1),
});

const instantiateProtocolOp: OperationHandler<
  z.infer<typeof instantiateProtocolInput>,
  ProtocolInstanceRow
> = async (ctx, rawInput) => {
  assertAllowed(await ctx.check(PROTO.create));
  const input = instantiateProtocolInput.parse(rawInput);
  const order = listOrders(ctx).find((o) => o.id === input.entityId);
  if (!order) throw new Error(`work order not found: ${input.entityId}`);
  if (order.status !== 'planned' && order.status !== 'in_progress') {
    throw new Error(`work order ${order.number} is '${order.status}' — protocols attach to open orders`);
  }
  return instantiateProtocol(ctx, {
    templateKey: input.templateKey,
    entity: { entityType: input.entityType, entityId: input.entityId },
  });
};

/** Portal listing: per-entity proof walks, no node-level permission required. */
const portalOrdersOp: OperationHandler<undefined, WorkOrder[]> = async (ctx) => {
  const all = listOrders(ctx);
  const visible: WorkOrder[] = [];
  for (const order of all) {
    const decision = await ctx.check(WO.read, { entityType: 'workorder', entityId: order.id });
    if (decision.allowed) visible.push(order);
  }
  return visible;
};

const timelineOp: OperationHandler<
  { entityType: string; entityId: string },
  { type: string; occurred_at: string; actor: string }[]
> = async (ctx, input) => {
  const entity: EntityRef = z
    .object({ entityType: z.string().min(1), entityId: z.string().min(1) })
    .parse(input);
  assertAllowed(await ctx.check(WO.read, entity));
  // Append order is authoritative — rowid, not ULID (ids emitted in the same
  // millisecond are not mutually ordered).
  return ctx.sql.query(
    `SELECT type, occurred_at, actor FROM _substrat_outbox
     WHERE entity_type = ? AND entity_id = ? ORDER BY rowid`,
    [entity.entityType, entity.entityId],
  );
};

export const servicecoModule: ModuleRegistration = {
  manifest: servicecoManifest,
  migrations: servicecoMigrations,
  operations: {
    'serviceco/create-customer': createCustomerOp as never,
    'serviceco/list-customers': listCustomersOp as never,
    'serviceco/create-facility': createFacilityOp as never,
    'serviceco/upsert-price': upsertPriceOp as never,
    'serviceco/price-list': priceListOp as never,
    'serviceco/create-workorder': createWorkOrderOp as never,
    'serviceco/complete-workorder': completeWorkOrderOp as never,
    'serviceco/instantiate-protocol': instantiateProtocolOp as never,
    'serviceco/portal-orders': portalOrdersOp as never,
    'serviceco/timeline': timelineOp as never,
  },
};
