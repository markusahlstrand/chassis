import { z } from 'zod';
import {
  dataSubjectId,
  entityRef,
  moduleManifest,
  permissionKey,
  type EntityRef,
} from '@substrat-run/contracts';
import {
  assertAllowed,
  ulid,
  type GuardPredicate,
  type ModuleRegistration,
  type OperationContext,
  type OperationHandler,
} from '@substrat-run/kernel';

// ============================================================================
// The protocol engine (docs/design/engine-protocol.md, extracted at milestone
// B per decision 27: the second vertical's shape — Handlebar's per-bike
// condition report with a customer counter-signature at pickup — forced the
// invariants out of Callout's vertical code). The engine owns ONLY the
// invariants; template CONTENT (which protocols exist, what they contain)
// is 100% vertical-owned:
//
//   1. sign freezes     — any write to a signed instance's responses fails
//   2. content_hash     — SHA-256 over template content + latest responses at
//                         sign time; verifiable against replayed state
//   3. counter-sign     — an ADDITIONAL signature row on the same frozen
//                         content (hash re-verified, never new content);
//                         exactly one primary signature per instance
//   4. append-only      — a response edit is a NEW row; history is audit
//                         material ("4.2 → 5.1 before signing")
//   5. version-pinned   — templates version immutably; an instance pins
//                         (key, version) at instantiation forever
//   6. void, not delete — a protocol is superseded, never mutated or removed
//
// Entity-agnostic: an instance binds to any EntityRef ('workorder' today,
// anything tomorrow). The vertical declares the `protocol → <parent>` entity
// relation in ITS manifest — the engine cannot know the vertical's vocabulary.
// ============================================================================

export const PROTOCOL_PERM = {
  create: permissionKey.parse('protocol:create'),
  fill: permissionKey.parse('protocol:fill'),
  sign: permissionKey.parse('protocol:sign'),
  countersign: permissionKey.parse('protocol:countersign'),
  read: permissionKey.parse('protocol:read'),
  void: permissionKey.parse('protocol:void'),
};

export const protocolManifest = moduleManifest.parse({
  id: '@substrat-run/engine-protocol',
  version: '0.0.1',
  kernelContract: '^0.0.1',
  permissions: [
    { key: 'protocol:create', description: 'Define protocol templates and start protocol instances on entities' },
    { key: 'protocol:fill', description: 'Record responses on an open protocol (append-only)' },
    { key: 'protocol:sign', description: 'Sign a protocol — freezes it forever (separate from fill: the technician fills, the arbetsledare signs)' },
    { key: 'protocol:countersign', description: 'Counter-sign an already-signed protocol — a second signature on the same frozen content (customer at pickup)' },
    { key: 'protocol:read', description: 'Read protocol templates, instances, responses and signatures' },
    { key: 'protocol:void', description: 'Void (supersede) a protocol — never deletes' },
  ],
  events: {
    emits: [
      { type: 'protocol.instantiated', schemaVersion: 1 },
      { type: 'protocol.response-recorded', schemaVersion: 1 },
      { type: 'protocol.signed', schemaVersion: 1 },
      { type: 'protocol.countersigned', schemaVersion: 1 },
      { type: 'protocol.voided', schemaVersion: 1 },
    ],
    consumes: [],
  },
  migrations: { journalDir: './migrations', compatibleFrom: '0.0.1' },
  attachmentTargets: [{ entityType: 'protocol', readPermission: 'protocol:read' }],
  entitlementKey: 'protocol',
  ui: {
    entityViews: [{ entityType: 'protocol', view: './ui/ProtocolPanel' }],
  },
});

export const protocolMigrations = [
  {
    version: '0001-init',
    sql: `
      CREATE TABLE protocol_templates (
        id           TEXT PRIMARY KEY,
        key          TEXT NOT NULL,
        version      INTEGER NOT NULL,
        title        TEXT NOT NULL,
        content_json TEXT NOT NULL,
        created_at   TEXT NOT NULL,
        UNIQUE (key, version)
      );
      CREATE TABLE protocol_instances (
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
      CREATE TABLE protocol_responses (
        id           TEXT PRIMARY KEY,
        instance_id  TEXT NOT NULL REFERENCES protocol_instances(id),
        item_key     TEXT NOT NULL,
        value_json   TEXT NOT NULL,
        note         TEXT,
        responded_by TEXT NOT NULL,
        responded_at TEXT NOT NULL
      );
      CREATE TABLE protocol_signatures (
        id           TEXT PRIMARY KEY,
        instance_id  TEXT NOT NULL REFERENCES protocol_instances(id),
        signed_by    TEXT NOT NULL,
        kind         TEXT NOT NULL CHECK (kind IN ('primary','counter')),
        method       TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        evidence_ref TEXT,
        signed_at    TEXT NOT NULL
      );
    `,
  },
];

// ---------------------------------------------------------------------------
// Template content SHAPE — engine-owned so fills can be validated against the
// pinned template. The content VALUES (sections, items, vocabulary,
// branschprotokoll packs) are written by verticals. v0 item types:
// check | value (measurement, decimal string) | text.
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
  kind: 'primary' | 'counter';
  method: string;
  content_hash: string;
  evidence_ref: string | null;
  signed_at: string;
}

const protocolRef = (id: string): EntityRef => ({ entityType: 'protocol', entityId: id });

function getInstanceRow(ctx: OperationContext, instanceId: string): ProtocolInstanceRow {
  const row = ctx.sql.query<ProtocolInstanceRow>(
    'SELECT * FROM protocol_instances WHERE id = ?',
    [instanceId],
  )[0];
  if (!row) throw new Error(`protocol instance not found: ${instanceId}`);
  return row;
}

function getTemplateRow(ctx: OperationContext, key: string, version: number): ProtocolTemplateRow {
  const row = ctx.sql.query<ProtocolTemplateRow>(
    'SELECT * FROM protocol_templates WHERE key = ? AND version = ?',
    [key, version],
  )[0];
  if (!row) throw new Error(`protocol template not found: ${key}@${version}`);
  return row;
}

/** Append order is authoritative for "latest wins" — rowid, not ULID (same-ms safe). */
function getResponseRows(ctx: OperationContext, instanceId: string): ProtocolResponseRow[] {
  return ctx.sql.query<ProtocolResponseRow>(
    'SELECT * FROM protocol_responses WHERE instance_id = ? ORDER BY rowid',
    [instanceId],
  );
}

function getSignatureRows(ctx: OperationContext, instanceId: string): ProtocolSignatureRow[] {
  return ctx.sql.query<ProtocolSignatureRow>(
    'SELECT * FROM protocol_signatures WHERE instance_id = ? ORDER BY rowid',
    [instanceId],
  );
}

function latestPerItem(responses: ProtocolResponseRow[]): Record<string, ProtocolResponseRow> {
  const latest: Record<string, ProtocolResponseRow> = {};
  for (const r of responses) latest[r.item_key] = r; // rowid order → last append wins
  return latest;
}

const frozenAnswers = (latest: Record<string, ProtocolResponseRow>): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(latest).map(([k, r]) => [k, JSON.parse(r.value_json) as unknown]),
  );

// ---------------------------------------------------------------------------
// content_hash — SHA-256 via Web Crypto (globalThis.crypto: same API in Node,
// Workers, and browsers; node-only imports never). The recipe is the contract:
// anyone can replay
//   '<key>@<version>\n<content_json>\n' + 'item=value_json\n' per item,
//   items sorted by key, latest response per item
// against the stored rows and compare. A counter-signature re-runs the same
// recipe and must land on the primary signature's hash — that is the "same
// frozen content" invariant made checkable.
// ---------------------------------------------------------------------------

// Web Crypto + TextEncoder are runtime globals everywhere we run (Node ≥ 18,
// Workers, browsers); declared locally so the engine needs no platform types.
declare const crypto: {
  subtle: { digest(algorithm: 'SHA-256', data: Uint8Array): Promise<ArrayBuffer> };
};
declare const TextEncoder: new () => { encode(input: string): Uint8Array };

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
// THE GUARD (engine-protocol.md §6, kernel-design open question 11). ONE
// predicate body, TWO ways to reach it — that is the whole open question:
//
//  pole 1 — VERTICAL-COMPOSED (milestone A): the vertical calls requireSigned()
//    inside its own operation before the engine transition. Right when the
//    policy is CONDITIONAL on vertical data ("only montage orders need an
//    self-inspection" — demos/callout): the condition is vertical vocabulary, and the
//    kernel must never learn it. Weakness: it is glue an edit can silently drop.
//
//  pole 2 — MANIFEST-DECLARED (milestone C): the engine contributes the named
//    predicate `protocol/all-signed` below; a VERTICAL manifest wires it to an
//    operation (`guards: [{ before, predicate, config }]`) and the kernel runs
//    it inside that operation's transaction, before the handler. Right when the
//    gate is UNCONDITIONAL ("a repair cannot be closed until the customer
//    counter-signed the tillståndsrapport" — demos/handlebar). Adding or
//    DROPPING the gate is then a manifest diff: human-checkpoint material.
//
// Both poles are the same read against the same engine-owned tables. Star
// topology holds either way: the workorder engine knows nothing of protocols.
// ---------------------------------------------------------------------------

export function requireSigned(ctx: OperationContext, entity: EntityRef, templateKey: string): void {
  const signed = ctx.sql.query<{ id: string }>(
    `SELECT id FROM protocol_instances
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

/**
 * The stronger form: signed AND counter-signed — the frozen content was
 * ACCEPTED by a second principal (the customer at pickup). Invariant 3 already
 * guarantees a counter-signature can only exist on verified frozen content, so
 * the existence of the row is the whole check.
 */
export function requireCountersigned(
  ctx: OperationContext,
  entity: EntityRef,
  templateKey: string,
): void {
  requireSigned(ctx, entity, templateKey);
  const counter = ctx.sql.query<{ id: string }>(
    `SELECT s.id FROM protocol_signatures s
     JOIN protocol_instances i ON i.id = s.instance_id
     WHERE i.entity_type = ? AND i.entity_id = ? AND i.template_key = ?
       AND i.status = 'signed' AND s.kind = 'counter'
     LIMIT 1`,
    [entity.entityType, entity.entityId, templateKey],
  )[0];
  if (!counter) {
    throw new Error(
      `protocol required: '${templateKey}' must be counter-signed before this transition ` +
        `(${entity.entityType} ${entity.entityId})`,
    );
  }
}

/**
 * Config for the `protocol/all-signed` predicate — parsed by the PREDICATE, not
 * by the kernel (the kernel keeps `config` opaque). `entityIdFrom` names the
 * field of the guarded operation's input that carries the entity id, which is
 * how one predicate serves any operation shape without the engine knowing the
 * vertical's vocabulary.
 */
export const allSignedGuardConfig = z.object({
  templateKey: z.string().min(1), // vertical content: 'tillstandsrapport'
  entityType: z.string().min(1), // what the protocol hangs on: 'workorder'
  entityIdFrom: z.string().min(1), // input field holding the id: 'orderId'
  countersigned: z.boolean().default(false), // require the customer's acceptance too
});
export type AllSignedGuardConfig = z.input<typeof allSignedGuardConfig>;

/** The named predicate the kernel resolves for `predicate: 'protocol/all-signed'`. */
export const allSignedPredicate: GuardPredicate = (ctx, rawConfig, input) => {
  const config = allSignedGuardConfig.parse(rawConfig);
  const entityId = z
    .string()
    .min(1, `guard 'protocol/all-signed': input field '${config.entityIdFrom}' carries no entity id`)
    .parse((input as Record<string, unknown> | undefined)?.[config.entityIdFrom]);
  const entity: EntityRef = { entityType: config.entityType, entityId };
  if (config.countersigned) requireCountersigned(ctx, entity, config.templateKey);
  else requireSigned(ctx, entity, config.templateKey);
};

// ---------------------------------------------------------------------------
// In-scope functions (K-16) — composable from vertical operations, same
// transaction. The registered operations below are their default bindings.
// The CALLER is responsible for the permission check.
// ---------------------------------------------------------------------------

export const defineTemplateInput = z.object({
  key: z.string().min(1),
  title: z.string().min(1),
  content: protocolTemplateContent,
});
export type DefineTemplateInput = z.infer<typeof defineTemplateInput>;

/**
 * Templates version immutably: same key + new content = next version, the
 * old row is never touched. Editing a template never rewrites what a signed
 * document referred to.
 */
export function defineTemplate(
  ctx: OperationContext,
  rawInput: DefineTemplateInput,
): ProtocolTemplateRow {
  const input = defineTemplateInput.parse(rawInput);
  const version =
    (ctx.sql.query<{ v: number }>(
      'SELECT COALESCE(MAX(version), 0) + 1 AS v FROM protocol_templates WHERE key = ?',
      [input.key],
    )[0]?.v as number) ?? 1;
  const id = ulid();
  ctx.sql.exec(
    `INSERT INTO protocol_templates (id, key, version, title, content_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, input.key, version, input.title, JSON.stringify(input.content), new Date().toISOString()],
  );
  return ctx.sql.query<ProtocolTemplateRow>('SELECT * FROM protocol_templates WHERE id = ?', [
    id,
  ])[0]!;
}

/** Latest version per key — the instantiation picker's list. */
export function listTemplates(ctx: OperationContext): ProtocolTemplateRow[] {
  return ctx.sql.query<ProtocolTemplateRow>(
    `SELECT t.* FROM protocol_templates t
     WHERE t.version = (SELECT MAX(version) FROM protocol_templates WHERE key = t.key)
     ORDER BY t.key`,
  );
}

export const instantiateProtocolInput = z.object({
  templateKey: z.string().min(1),
  entity: entityRef,
});
export type InstantiateProtocolInput = z.infer<typeof instantiateProtocolInput>;

/**
 * Pins the latest template version at instantiation — forever (invariant 5).
 * One OPEN instance per (template, entity). Which entity types may carry
 * which protocols, and when, is vertical policy — enforced by the caller.
 */
export function instantiateProtocol(
  ctx: OperationContext,
  rawInput: InstantiateProtocolInput,
): ProtocolInstanceRow {
  const input = instantiateProtocolInput.parse(rawInput);
  const template = ctx.sql.query<ProtocolTemplateRow>(
    'SELECT * FROM protocol_templates WHERE key = ? ORDER BY version DESC LIMIT 1',
    [input.templateKey],
  )[0];
  if (!template) throw new Error(`protocol template not found: ${input.templateKey}`);

  const dup = ctx.sql.query<{ id: string }>(
    `SELECT id FROM protocol_instances
     WHERE entity_type = ? AND entity_id = ? AND template_key = ? AND status = 'open' LIMIT 1`,
    [input.entity.entityType, input.entity.entityId, input.templateKey],
  )[0];
  if (dup) {
    throw new Error(
      `protocol '${input.templateKey}' already open on this ${input.entity.entityType}`,
    );
  }

  const id = ulid();
  ctx.sql.exec(
    `INSERT INTO protocol_instances
       (id, template_key, template_version, entity_type, entity_id, status, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, 'open', ?, ?)`,
    [
      id,
      template.key,
      template.version,
      input.entity.entityType,
      input.entity.entityId,
      ctx.principal,
      new Date().toISOString(),
    ],
  );
  // The permission walk (portal counter-sign, per-entity reads) flows along
  // this edge; the vertical declares `protocol → <parent>` in its manifest.
  ctx.link(protocolRef(id), input.entity);
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
      entity: input.entity,
    },
  });
  return getInstanceRow(ctx, id);
}

export const fillProtocolInput = z.object({
  instanceId: z.string().min(1),
  itemKey: z.string().min(1),
  value: responseValue,
  note: z.string().optional(),
});
export type FillProtocolInput = z.infer<typeof fillProtocolInput>;

export function fillProtocol(
  ctx: OperationContext,
  rawInput: FillProtocolInput,
): ProtocolResponseRow {
  const input = fillProtocolInput.parse(rawInput);
  const instance = getInstanceRow(ctx, input.instanceId);

  // Invariant 1+4: responses bind to an OPEN instance only, and always append.
  if (instance.status !== 'open') {
    throw new Error(`protocol is ${instance.status}: responses are frozen (append-only history kept)`);
  }

  const template = getTemplateRow(ctx, instance.template_key, instance.template_version);
  const content = protocolTemplateContent.parse(JSON.parse(template.content_json));
  const item = content.sections.flatMap((s) => s.items).find((i) => i.key === input.itemKey);
  if (!item) {
    throw new Error(
      `unknown item '${input.itemKey}' in template ${instance.template_key}@${instance.template_version}`,
    );
  }
  if (item.type === 'check' && typeof input.value !== 'boolean') {
    throw new Error(`item '${item.key}' is a check: value must be boolean`);
  }
  if (item.type !== 'check' && typeof input.value !== 'string') {
    throw new Error(`item '${item.key}' is a ${item.type}: value must be a string`);
  }

  const id = ulid();
  ctx.sql.exec(
    `INSERT INTO protocol_responses
       (id, instance_id, item_key, value_json, note, responded_by, responded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      instance.id,
      input.itemKey,
      JSON.stringify(input.value),
      input.note ?? null,
      ctx.principal,
      new Date().toISOString(),
    ],
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
  return ctx.sql.query<ProtocolResponseRow>('SELECT * FROM protocol_responses WHERE id = ?', [
    id,
  ])[0]!;
}

export interface SignResult {
  instance: ProtocolInstanceRow;
  signature: ProtocolSignatureRow;
}

/**
 * In-app sign (engine-protocol.md §5): the authenticated principal signs;
 * integrity comes from the hash + immutability + the spine event. Connector
 * methods (bankid/scrive) arrive later through the SAME operation shape with
 * upgraded evidence. Exactly ONE primary signature per instance — enforced by
 * the open → signed transition.
 */
export async function signProtocol(
  ctx: OperationContext,
  input: { instanceId: string },
): Promise<SignResult> {
  const instance = getInstanceRow(ctx, z.string().min(1).parse(input.instanceId));
  if (instance.status !== 'open') {
    throw new Error(`protocol is ${instance.status}: only an open protocol can be signed`);
  }
  const template = getTemplateRow(ctx, instance.template_key, instance.template_version);
  const latest = latestPerItem(getResponseRows(ctx, instance.id));
  const contentHash = await protocolContentHash(template, latest);
  const id = ulid();
  ctx.sql.exec(
    `INSERT INTO protocol_signatures
       (id, instance_id, signed_by, kind, method, content_hash, evidence_ref, signed_at)
     VALUES (?, ?, ?, 'primary', 'in-app', ?, NULL, ?)`,
    [id, instance.id, ctx.principal, contentHash, new Date().toISOString()],
  );
  ctx.sql.exec(`UPDATE protocol_instances SET status = 'signed' WHERE id = ?`, [instance.id]);
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
      responses: frozenAnswers(latest),
    },
  });
  return {
    instance: getInstanceRow(ctx, instance.id),
    signature: getSignatureRows(ctx, instance.id).find((s) => s.id === id)!,
  };
}

/**
 * Counter-sign (invariant 3): a SECOND signature on the SAME frozen content —
 * the customer at pickup. Requires a signed instance; the content hash is
 * recomputed and must equal the primary signature's hash (frozen content,
 * verified, never assumed). One counter-signature per principal; a principal
 * never counter-signs what they primary-signed.
 */
export async function countersignProtocol(
  ctx: OperationContext,
  input: { instanceId: string },
): Promise<SignResult> {
  const instance = getInstanceRow(ctx, z.string().min(1).parse(input.instanceId));
  if (instance.status !== 'signed') {
    throw new Error(
      `protocol is ${instance.status}: only a signed (frozen) protocol can be counter-signed`,
    );
  }
  const signatures = getSignatureRows(ctx, instance.id);
  const primary = signatures.find((s) => s.kind === 'primary');
  if (!primary) throw new Error(`signed protocol has no primary signature: ${instance.id}`); // corrupt state, fail closed
  if (primary.signed_by === ctx.principal) {
    throw new Error('counter-signature must come from a different principal than the signer');
  }
  if (signatures.some((s) => s.kind === 'counter' && s.signed_by === ctx.principal)) {
    throw new Error('already counter-signed by this principal');
  }

  // Re-run the hash recipe against stored state: the counter-signature binds
  // to verified frozen content, not to a trusted column.
  const template = getTemplateRow(ctx, instance.template_key, instance.template_version);
  const latest = latestPerItem(getResponseRows(ctx, instance.id));
  const contentHash = await protocolContentHash(template, latest);
  if (contentHash !== primary.content_hash) {
    throw new Error(
      `content hash mismatch on counter-sign: stored ${primary.content_hash}, replayed ${contentHash}`,
    );
  }

  const id = ulid();
  ctx.sql.exec(
    `INSERT INTO protocol_signatures
       (id, instance_id, signed_by, kind, method, content_hash, evidence_ref, signed_at)
     VALUES (?, ?, ?, 'counter', 'in-app', ?, NULL, ?)`,
    [id, instance.id, ctx.principal, contentHash, new Date().toISOString()],
  );
  ctx.emit({
    type: 'protocol.countersigned',
    schemaVersion: 1,
    entity: protocolRef(instance.id),
    piiClass: 'pseudonymous',
    subjectId: dataSubjectId.parse(ctx.principal),
    payload: {
      instanceId: instance.id,
      templateKey: instance.template_key,
      templateVersion: instance.template_version,
      entity: { entityType: instance.entity_type, entityId: instance.entity_id },
      signedBy: primary.signed_by,
      countersignedBy: ctx.principal,
      method: 'in-app',
      contentHash,
      responses: frozenAnswers(latest),
    },
  });
  return {
    instance: getInstanceRow(ctx, instance.id),
    signature: getSignatureRows(ctx, instance.id).find((s) => s.id === id)!,
  };
}

/** Voiding, not deleting: a superseded protocol keeps its rows forever. */
export function voidProtocol(
  ctx: OperationContext,
  input: { instanceId: string; reason: string },
): ProtocolInstanceRow {
  const reason = z.string().min(1).parse(input.reason);
  const instance = getInstanceRow(ctx, z.string().min(1).parse(input.instanceId));
  if (instance.status === 'voided') throw new Error('protocol is already voided');
  ctx.sql.exec(
    `UPDATE protocol_instances
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
  return getInstanceRow(ctx, instance.id);
}

export interface ProtocolDetail {
  instance: ProtocolInstanceRow;
  template: { key: string; version: number; title: string; content: ProtocolTemplateContent };
  responses: ProtocolResponseRow[]; // full append-only history
  latest: Record<string, ProtocolResponseRow>; // per-item, last append wins
  signature: ProtocolSignatureRow | null; // the primary (freezing) signature
  signatures: ProtocolSignatureRow[]; // all rows, primary + counter-signatures
}

export function getProtocol(ctx: OperationContext, instanceId: string): ProtocolDetail {
  const instance = getInstanceRow(ctx, instanceId);
  const template = getTemplateRow(ctx, instance.template_key, instance.template_version);
  const responses = getResponseRows(ctx, instance.id);
  const signatures = getSignatureRows(ctx, instance.id);
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
    signature: signatures.find((s) => s.kind === 'primary') ?? null,
    signatures,
  };
}

export interface ProtocolSummary {
  instance: ProtocolInstanceRow;
  title: string;
  answered: number;
  total: number;
  signedBy: string | null;
  signedAt: string | null;
  countersignedBy: string | null;
  countersignedAt: string | null;
}

export function listProtocolsForEntity(ctx: OperationContext, entity: EntityRef): ProtocolSummary[] {
  const instances = ctx.sql.query<ProtocolInstanceRow>(
    `SELECT * FROM protocol_instances
     WHERE entity_type = ? AND entity_id = ? ORDER BY rowid`,
    [entity.entityType, entity.entityId],
  );
  return instances.map((instance) => {
    const template = getTemplateRow(ctx, instance.template_key, instance.template_version);
    const content = protocolTemplateContent.parse(JSON.parse(template.content_json));
    const total = content.sections.reduce((n, s) => n + s.items.length, 0);
    const answered = Object.keys(latestPerItem(getResponseRows(ctx, instance.id))).length;
    const signatures = getSignatureRows(ctx, instance.id);
    const primary = signatures.find((s) => s.kind === 'primary');
    const counter = signatures.filter((s) => s.kind === 'counter').at(-1);
    return {
      instance,
      title: template.title,
      answered,
      total,
      signedBy: primary?.signed_by ?? null,
      signedAt: primary?.signed_at ?? null,
      countersignedBy: counter?.signed_by ?? null,
      countersignedAt: counter?.signed_at ?? null,
    };
  });
}

// ---------------------------------------------------------------------------
// Default operation bindings — each starts with the permission check.
// Reads and per-instance mutations check per-entity (portal-style walks:
// role checks still pass at the node; entity-narrowed grants resolve along
// the vertical-declared parent edges).
// ---------------------------------------------------------------------------

const defineTemplateOp: OperationHandler<DefineTemplateInput, ProtocolTemplateRow> = async (
  ctx,
  input,
) => {
  assertAllowed(await ctx.check(PROTOCOL_PERM.create));
  return defineTemplate(ctx, input);
};

const listTemplatesOp: OperationHandler<undefined, ProtocolTemplateRow[]> = async (ctx) => {
  assertAllowed(await ctx.check(PROTOCOL_PERM.read));
  return listTemplates(ctx);
};

const instantiateOp: OperationHandler<
  { templateKey: string; entityType: string; entityId: string },
  ProtocolInstanceRow
> = async (ctx, input) => {
  assertAllowed(await ctx.check(PROTOCOL_PERM.create));
  return instantiateProtocol(ctx, {
    templateKey: input.templateKey,
    entity: { entityType: input.entityType, entityId: input.entityId },
  });
};

const fillOp: OperationHandler<FillProtocolInput, ProtocolResponseRow> = async (ctx, input) => {
  assertAllowed(await ctx.check(PROTOCOL_PERM.fill, protocolRef(input.instanceId)));
  return fillProtocol(ctx, input);
};

const signOp: OperationHandler<{ instanceId: string }, SignResult> = async (ctx, input) => {
  assertAllowed(await ctx.check(PROTOCOL_PERM.sign, protocolRef(input.instanceId)));
  return signProtocol(ctx, input);
};

const countersignOp: OperationHandler<{ instanceId: string }, SignResult> = async (ctx, input) => {
  assertAllowed(await ctx.check(PROTOCOL_PERM.countersign, protocolRef(input.instanceId)));
  return countersignProtocol(ctx, input);
};

const voidOp: OperationHandler<{ instanceId: string; reason: string }, ProtocolInstanceRow> =
  async (ctx, input) => {
    assertAllowed(await ctx.check(PROTOCOL_PERM.void, protocolRef(input.instanceId)));
    return voidProtocol(ctx, input);
  };

const getOp: OperationHandler<{ instanceId: string }, ProtocolDetail> = async (ctx, input) => {
  assertAllowed(await ctx.check(PROTOCOL_PERM.read, protocolRef(input.instanceId)));
  return getProtocol(ctx, input.instanceId);
};

const listForEntityOp: OperationHandler<
  { entityType: string; entityId: string },
  ProtocolSummary[]
> = async (ctx, input) => {
  const entity: EntityRef = entityRef.parse(input);
  assertAllowed(await ctx.check(PROTOCOL_PERM.read, entity));
  return listProtocolsForEntity(ctx, entity);
};

export const protocolModule: ModuleRegistration = {
  manifest: protocolManifest,
  migrations: protocolMigrations,
  // The engine CONTRIBUTES the predicate; a vertical manifest WIRES it (K-17).
  // The engine never declares a guard of its own: what is mandatory when is
  // vertical policy, and the engine cannot know another module's operations.
  predicates: {
    'protocol/all-signed': allSignedPredicate,
  },
  operations: {
    'protocol/define-template': defineTemplateOp as OperationHandler<never, unknown>,
    'protocol/list-templates': listTemplatesOp as OperationHandler<never, unknown>,
    'protocol/instantiate': instantiateOp as OperationHandler<never, unknown>,
    'protocol/fill': fillOp as OperationHandler<never, unknown>,
    'protocol/sign': signOp as OperationHandler<never, unknown>,
    'protocol/countersign': countersignOp as OperationHandler<never, unknown>,
    'protocol/void': voidOp as OperationHandler<never, unknown>,
    'protocol/get': getOp as OperationHandler<never, unknown>,
    'protocol/list-for-entity': listForEntityOp as OperationHandler<never, unknown>,
  },
};
