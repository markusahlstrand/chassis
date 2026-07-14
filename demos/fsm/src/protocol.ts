import { z } from 'zod';
import { dataSubjectId, permissionKey, type EntityRef } from '@substrat-run/contracts';
import {
  assertAllowed,
  ulid,
  type OperationContext,
  type OperationHandler,
} from '@substrat-run/kernel';
import { listOrders } from '@substrat-run/engine-workorder';

// ============================================================================
// Protocols/egenkontroller — MILESTONE A of docs/design/engine-protocol.md:
// ServiceCo VERTICAL code, deliberately not an engine yet (decision 27 —
// engines are extracted at the second vertical; milestone B moves the
// invariants below into engines/protocol and leaves the templates behind as
// content). Until then the invariants live here, enforced in these operations:
//
//   1. sign freezes    — any write to a signed instance's responses fails
//   2. content_hash    — hash over template content + latest responses at
//                        sign time; verifiable against replayed state
//   3. append-only     — a response edit is a NEW row; history is audit
//                        material ("4.2 → 5.1 before signing")
//   4. version-pinned  — templates version immutably; an instance pins
//                        (key, version) at instantiation forever
//   5. void, not delete — a signed protocol is superseded, never mutated
// ============================================================================

export const PROTO_PERM = {
  create: permissionKey.parse('protocol:create'),
  fill: permissionKey.parse('protocol:fill'),
  sign: permissionKey.parse('protocol:sign'),
  read: permissionKey.parse('protocol:read'),
  void: permissionKey.parse('protocol:void'),
};

/** Appended to the vertical's journal in module.ts — never edit 0001. */
export const protocolMigration = {
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
};

// ---------------------------------------------------------------------------
// Template content — 100% vertical vocabulary (sections/items). v0 item
// types: check | value (measurement, decimal string) | text.
// ---------------------------------------------------------------------------

export const protocolItem = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  type: z.enum(['check', 'value', 'text']),
  unit: z.string().optional(), // 'MΩ' on measurements
});
export type ProtocolItem = z.infer<typeof protocolItem>;

export const protocolTemplateContent = z.object({
  sections: z
    .array(z.object({ title: z.string().min(1), items: z.array(protocolItem).min(1) }))
    .min(1),
});
export type ProtocolTemplateContent = z.infer<typeof protocolTemplateContent>;

/** Booleans for checks; strings for measurements/text (decimals stay strings, K-14). */
const responseValue = z.union([z.boolean(), z.string()]);

export interface ProtocolTemplateRow {
  id: string;
  key: string;
  version: number;
  title: string;
  content_json: string;
  created_at: string;
}

export interface ProtocolInstanceRow {
  id: string;
  template_key: string;
  template_version: number;
  entity_type: string;
  entity_id: string;
  status: 'open' | 'signed' | 'voided';
  created_by: string;
  created_at: string;
  voided_by: string | null;
  voided_reason: string | null;
  voided_at: string | null;
}

export interface ProtocolResponseRow {
  id: string;
  instance_id: string;
  item_key: string;
  value_json: string;
  note: string | null;
  responded_by: string;
  responded_at: string;
}

export interface ProtocolSignatureRow {
  id: string;
  instance_id: string;
  signed_by: string;
  method: string;
  content_hash: string;
  evidence_ref: string | null;
  signed_at: string;
}

const protocolRef = (id: string): EntityRef => ({ entityType: 'protocol', entityId: id });

function getInstance(ctx: OperationContext, instanceId: string): ProtocolInstanceRow {
  const row = ctx.sql.query<ProtocolInstanceRow>(
    'SELECT * FROM serviceco_protocol_instances WHERE id = ?',
    [instanceId],
  )[0];
  if (!row) throw new Error(`protocol instance not found: ${instanceId}`);
  return row;
}

function getTemplate(ctx: OperationContext, key: string, version: number): ProtocolTemplateRow {
  const row = ctx.sql.query<ProtocolTemplateRow>(
    'SELECT * FROM serviceco_protocol_templates WHERE key = ? AND version = ?',
    [key, version],
  )[0];
  if (!row) throw new Error(`protocol template not found: ${key}@${version}`);
  return row;
}

/** Append order is authoritative for "latest wins" — rowid, not ULID (same-ms safe). */
function getResponses(ctx: OperationContext, instanceId: string): ProtocolResponseRow[] {
  return ctx.sql.query<ProtocolResponseRow>(
    'SELECT * FROM serviceco_protocol_responses WHERE instance_id = ? ORDER BY rowid',
    [instanceId],
  );
}

function latestPerItem(responses: ProtocolResponseRow[]): Record<string, ProtocolResponseRow> {
  const latest: Record<string, ProtocolResponseRow> = {};
  for (const r of responses) latest[r.item_key] = r; // rowid order → last append wins
  return latest;
}

// ---------------------------------------------------------------------------
// content_hash — SHA-256 via Web Crypto (globalThis.crypto: same API in Node,
// Workers, and browsers; node-only imports never). The recipe is the contract:
// anyone can replay
//   '<key>@<version>\n<content_json>\n' + 'item=value_json\n' per item,
//   items sorted by key, latest response per item
// against the stored rows and compare.
// ---------------------------------------------------------------------------

export async function protocolContentHash(
  template: Pick<ProtocolTemplateRow, 'key' | 'version' | 'content_json'>,
  latest: Record<string, ProtocolResponseRow>,
): Promise<string> {
  const lines = Object.keys(latest)
    .sort()
    .map((k) => `${k}=${latest[k]!.value_json}\n`)
    .join('');
  const input = `${template.key}@${template.version}\n${template.content_json}\n${lines}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// THE GUARD, milestone-A pole (engine-protocol.md §6, kernel-design open
// question 11): a plain in-scope predicate the vertical composes into its
// own operations BEFORE calling an engine transition. The manifest-declared
// form is milestone C; until then this call is the compliance gate — do not
// remove it without a human checkpoint.
// ---------------------------------------------------------------------------

export function requireSigned(ctx: OperationContext, entity: EntityRef, templateKey: string): void {
  const signed = ctx.sql.query<{ id: string }>(
    `SELECT id FROM serviceco_protocol_instances
     WHERE entity_type = ? AND entity_id = ? AND template_key = ? AND status = 'signed'
     LIMIT 1`,
    [entity.entityType, entity.entityId, templateKey],
  )[0];
  if (!signed) {
    throw new Error(
      `protocol required: '${templateKey}' must be signed before this transition ` +
        `(${entity.entityType} ${entity.entityId})`,
    );
  }
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/**
 * Templates version immutably: same key + new content = next version, the
 * old row is never touched. (Template authoring shares `protocol:create`
 * with instantiation in v0 — an office task either way.)
 */
const defineTemplateOp: OperationHandler<
  { key: string; title: string; content: ProtocolTemplateContent },
  ProtocolTemplateRow
> = async (ctx, input) => {
  assertAllowed(await ctx.check(PROTO_PERM.create));
  const key = z.string().min(1).parse(input.key);
  const title = z.string().min(1).parse(input.title);
  const content = protocolTemplateContent.parse(input.content);
  const version =
    (ctx.sql.query<{ v: number }>(
      'SELECT COALESCE(MAX(version), 0) + 1 AS v FROM serviceco_protocol_templates WHERE key = ?',
      [key],
    )[0]?.v as number) ?? 1;
  const id = ulid();
  ctx.sql.exec(
    `INSERT INTO serviceco_protocol_templates (id, key, version, title, content_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, key, version, title, JSON.stringify(content), new Date().toISOString()],
  );
  return ctx.sql.query<ProtocolTemplateRow>(
    'SELECT * FROM serviceco_protocol_templates WHERE id = ?',
    [id],
  )[0]!;
};

/** Latest version per key — the instantiation picker's list. */
const listTemplatesOp: OperationHandler<undefined, ProtocolTemplateRow[]> = async (ctx) => {
  assertAllowed(await ctx.check(PROTO_PERM.read));
  return ctx.sql.query<ProtocolTemplateRow>(
    `SELECT t.* FROM serviceco_protocol_templates t
     WHERE t.version = (SELECT MAX(version) FROM serviceco_protocol_templates WHERE key = t.key)
     ORDER BY t.key`,
  );
};

const instantiateInput = z.object({
  templateKey: z.string().min(1),
  entityType: z.literal('workorder'), // 'later anything' — engine-protocol.md §1
  entityId: z.string().min(1),
});

const instantiateOp: OperationHandler<
  z.infer<typeof instantiateInput>,
  ProtocolInstanceRow
> = async (ctx, rawInput) => {
  assertAllowed(await ctx.check(PROTO_PERM.create));
  const input = instantiateInput.parse(rawInput);

  // Pin the latest template version at instantiation — forever (invariant 4).
  const template = ctx.sql.query<ProtocolTemplateRow>(
    'SELECT * FROM serviceco_protocol_templates WHERE key = ? ORDER BY version DESC LIMIT 1',
    [input.templateKey],
  )[0];
  if (!template) throw new Error(`protocol template not found: ${input.templateKey}`);

  // Vertical policy: protocols attach to orders still being worked.
  const order = listOrders(ctx).find((o) => o.id === input.entityId);
  if (!order) throw new Error(`work order not found: ${input.entityId}`);
  if (order.status !== 'planned' && order.status !== 'in_progress') {
    throw new Error(`work order ${order.number} is '${order.status}' — protocols attach to open orders`);
  }
  const dup = ctx.sql.query<{ id: string }>(
    `SELECT id FROM serviceco_protocol_instances
     WHERE entity_type = ? AND entity_id = ? AND template_key = ? AND status = 'open' LIMIT 1`,
    [input.entityType, input.entityId, input.templateKey],
  )[0];
  if (dup) throw new Error(`protocol '${input.templateKey}' already open on this ${input.entityType}`);

  const id = ulid();
  ctx.sql.exec(
    `INSERT INTO serviceco_protocol_instances
       (id, template_key, template_version, entity_type, entity_id, status, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, 'open', ?, ?)`,
    [id, template.key, template.version, input.entityType, input.entityId, ctx.principal, new Date().toISOString()],
  );
  ctx.link(protocolRef(id), { entityType: input.entityType, entityId: input.entityId });
  ctx.emit({
    type: 'protocol.instantiated',
    schemaVersion: 1,
    entity: protocolRef(id),
    piiClass: 'none',
    payload: {
      instanceId: id,
      templateKey: template.key,
      templateVersion: template.version,
      title: template.title,
      entity: { entityType: input.entityType, entityId: input.entityId },
    },
  });
  return getInstance(ctx, id);
};

const fillInput = z.object({
  instanceId: z.string().min(1),
  itemKey: z.string().min(1),
  value: responseValue,
  note: z.string().optional(),
});

const fillOp: OperationHandler<z.infer<typeof fillInput>, ProtocolResponseRow> = async (
  ctx,
  rawInput,
) => {
  assertAllowed(await ctx.check(PROTO_PERM.fill, protocolRef(rawInput.instanceId)));
  const input = fillInput.parse(rawInput);
  const instance = getInstance(ctx, input.instanceId);

  // Invariant 1+3: responses bind to an OPEN instance only, and always append.
  if (instance.status !== 'open') {
    throw new Error(`protocol is ${instance.status}: responses are frozen (append-only history kept)`);
  }

  const template = getTemplate(ctx, instance.template_key, instance.template_version);
  const content = protocolTemplateContent.parse(JSON.parse(template.content_json));
  const item = content.sections.flatMap((s) => s.items).find((i) => i.key === input.itemKey);
  if (!item) {
    throw new Error(`unknown item '${input.itemKey}' in template ${instance.template_key}@${instance.template_version}`);
  }
  if (item.type === 'check' && typeof input.value !== 'boolean') {
    throw new Error(`item '${item.key}' is a check: value must be boolean`);
  }
  if (item.type !== 'check' && typeof input.value !== 'string') {
    throw new Error(`item '${item.key}' is a ${item.type}: value must be a string`);
  }

  const id = ulid();
  const valueJson = JSON.stringify(input.value);
  ctx.sql.exec(
    `INSERT INTO serviceco_protocol_responses
       (id, instance_id, item_key, value_json, note, responded_by, responded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, instance.id, input.itemKey, valueJson, input.note ?? null, ctx.principal, new Date().toISOString()],
  );
  ctx.emit({
    type: 'protocol.response-recorded',
    schemaVersion: 1,
    entity: protocolRef(instance.id),
    piiClass: 'pseudonymous',
    subjectId: dataSubjectId.parse(ctx.principal),
    payload: {
      instanceId: instance.id,
      responseId: id,
      itemKey: input.itemKey,
      value: input.value,
      entity: { entityType: instance.entity_type, entityId: instance.entity_id },
    },
  });
  return ctx.sql.query<ProtocolResponseRow>(
    'SELECT * FROM serviceco_protocol_responses WHERE id = ?',
    [id],
  )[0]!;
};

/**
 * In-app sign (engine-protocol.md §5): the authenticated principal signs;
 * integrity comes from the hash + immutability + the spine event. Connector
 * methods (bankid/scrive) arrive later through the SAME operation shape with
 * upgraded evidence. `protocol:sign` is deliberately a separate permission
 * from `protocol:fill` — the technician fills, the arbetsledare signs.
 */
const signOp: OperationHandler<
  { instanceId: string },
  { instance: ProtocolInstanceRow; signature: ProtocolSignatureRow }
> = async (ctx, input) => {
  assertAllowed(await ctx.check(PROTO_PERM.sign, protocolRef(input.instanceId)));
  const instance = getInstance(ctx, input.instanceId);
  if (instance.status !== 'open') {
    throw new Error(`protocol is ${instance.status}: only an open protocol can be signed`);
  }
  const template = getTemplate(ctx, instance.template_key, instance.template_version);
  const responses = getResponses(ctx, instance.id);
  const latest = latestPerItem(responses);
  const contentHash = await protocolContentHash(template, latest);
  const signedAt = new Date().toISOString();
  const id = ulid();
  ctx.sql.exec(
    `INSERT INTO serviceco_protocol_signatures
       (id, instance_id, signed_by, method, content_hash, evidence_ref, signed_at)
     VALUES (?, ?, ?, 'in-app', ?, NULL, ?)`,
    [id, instance.id, ctx.principal, contentHash, signedAt],
  );
  ctx.sql.exec(`UPDATE serviceco_protocol_instances SET status = 'signed' WHERE id = ?`, [
    instance.id,
  ]);
  ctx.emit({
    type: 'protocol.signed',
    schemaVersion: 1,
    entity: protocolRef(instance.id),
    piiClass: 'pseudonymous',
    subjectId: dataSubjectId.parse(ctx.principal),
    payload: {
      instanceId: instance.id,
      templateKey: instance.template_key,
      templateVersion: instance.template_version,
      entity: { entityType: instance.entity_type, entityId: instance.entity_id },
      signedBy: ctx.principal,
      method: 'in-app',
      contentHash,
      // fat payload: the frozen answers travel with the event
      responses: Object.fromEntries(
        Object.entries(latest).map(([k, r]) => [k, JSON.parse(r.value_json) as unknown]),
      ),
    },
  });
  return {
    instance: getInstance(ctx, instance.id),
    signature: ctx.sql.query<ProtocolSignatureRow>(
      'SELECT * FROM serviceco_protocol_signatures WHERE id = ?',
      [id],
    )[0]!,
  };
};

/** Voiding, not deleting: a superseded protocol keeps its rows forever. */
const voidOp: OperationHandler<
  { instanceId: string; reason: string },
  ProtocolInstanceRow
> = async (ctx, input) => {
  assertAllowed(await ctx.check(PROTO_PERM.void, protocolRef(input.instanceId)));
  const reason = z.string().min(1).parse(input.reason);
  const instance = getInstance(ctx, input.instanceId);
  if (instance.status === 'voided') throw new Error('protocol is already voided');
  ctx.sql.exec(
    `UPDATE serviceco_protocol_instances
     SET status = 'voided', voided_by = ?, voided_reason = ?, voided_at = ? WHERE id = ?`,
    [ctx.principal, reason, new Date().toISOString(), instance.id],
  );
  ctx.emit({
    type: 'protocol.voided',
    schemaVersion: 1,
    entity: protocolRef(instance.id),
    piiClass: 'pseudonymous',
    subjectId: dataSubjectId.parse(ctx.principal),
    payload: {
      instanceId: instance.id,
      entity: { entityType: instance.entity_type, entityId: instance.entity_id },
      previousStatus: instance.status,
      reason,
    },
  });
  return getInstance(ctx, instance.id);
};

export interface ProtocolDetail {
  instance: ProtocolInstanceRow;
  template: { key: string; version: number; title: string; content: ProtocolTemplateContent };
  responses: ProtocolResponseRow[]; // full append-only history
  latest: Record<string, ProtocolResponseRow>; // per-item, last append wins
  signature: ProtocolSignatureRow | null;
}

const getOp: OperationHandler<{ instanceId: string }, ProtocolDetail> = async (ctx, input) => {
  assertAllowed(await ctx.check(PROTO_PERM.read, protocolRef(input.instanceId)));
  const instance = getInstance(ctx, input.instanceId);
  const template = getTemplate(ctx, instance.template_key, instance.template_version);
  const responses = getResponses(ctx, instance.id);
  const signature =
    ctx.sql.query<ProtocolSignatureRow>(
      'SELECT * FROM serviceco_protocol_signatures WHERE instance_id = ? ORDER BY rowid',
      [instance.id],
    )[0] ?? null;
  return {
    instance,
    template: {
      key: template.key,
      version: template.version,
      title: template.title,
      content: protocolTemplateContent.parse(JSON.parse(template.content_json)),
    },
    responses,
    latest: latestPerItem(responses),
    signature,
  };
};

export interface ProtocolSummary {
  instance: ProtocolInstanceRow;
  title: string;
  answered: number;
  total: number;
  signedBy: string | null;
  signedAt: string | null;
}

const listForEntityOp: OperationHandler<
  { entityType: string; entityId: string },
  ProtocolSummary[]
> = async (ctx, input) => {
  assertAllowed(await ctx.check(PROTO_PERM.read));
  const entity = z
    .object({ entityType: z.string().min(1), entityId: z.string().min(1) })
    .parse(input);
  const instances = ctx.sql.query<ProtocolInstanceRow>(
    `SELECT * FROM serviceco_protocol_instances
     WHERE entity_type = ? AND entity_id = ? ORDER BY rowid`,
    [entity.entityType, entity.entityId],
  );
  return instances.map((instance) => {
    const template = getTemplate(ctx, instance.template_key, instance.template_version);
    const content = protocolTemplateContent.parse(JSON.parse(template.content_json));
    const total = content.sections.reduce((n, s) => n + s.items.length, 0);
    const answered = Object.keys(latestPerItem(getResponses(ctx, instance.id))).length;
    const signature = ctx.sql.query<ProtocolSignatureRow>(
      'SELECT * FROM serviceco_protocol_signatures WHERE instance_id = ? ORDER BY rowid',
      [instance.id],
    )[0];
    return {
      instance,
      title: template.title,
      answered,
      total,
      signedBy: signature?.signed_by ?? null,
      signedAt: signature?.signed_at ?? null,
    };
  });
};

export const protocolOperations = {
  'serviceco/define-protocol-template': defineTemplateOp as never,
  'serviceco/list-protocol-templates': listTemplatesOp as never,
  'serviceco/instantiate-protocol': instantiateOp as never,
  'serviceco/fill-protocol': fillOp as never,
  'serviceco/sign-protocol': signOp as never,
  'serviceco/void-protocol': voidOp as never,
  'serviceco/get-protocol': getOp as never,
  'serviceco/list-protocols': listForEntityOp as never,
};
