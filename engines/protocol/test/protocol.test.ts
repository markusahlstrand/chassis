import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { EntityRef } from '@substrat-run/contracts';
import { engineHarness, type EngineHarness } from '@substrat-run/engine-test-kit';
import {
  PROTOCOL_PERM as PERM,
  protocolModule,
  requireSigned,
  type ProtocolInstanceRow,
  type ProtocolTemplateRow,
  type SignResult,
} from '../src/index.js';

/**
 * The protocol engine, tested directly. Its reason to exist is one invariant —
 * **sign freezes the document forever** — and the compliance value of the whole
 * engine rests on that holding on the adverse paths, not the happy one.
 */

const BIKE: EntityRef = { entityType: 'workorder', entityId: '01JWORKORDER000000000000000' };

const CONTENT = {
  sections: [
    {
      title: 'Broms',
      items: [
        { key: 'front-brake', label: 'Frambroms', type: 'check' as const },
        { key: 'pad-mm', label: 'Belägg', type: 'value' as const, unit: 'mm' },
      ],
    },
  ],
};

describe('engine-protocol', () => {
  let h: EngineHarness;
  let staff: Awaited<ReturnType<EngineHarness['as']>>;

  beforeEach(async () => {
    h = await engineHarness({
      modules: [protocolModule],
      // The engine has never heard of a work order — a vertical declares this
      // edge, and the kernel refuses `ctx.link` without it. The harness plays
      // the vertical's part.
      entityRelations: [{ entityType: 'protocol', parentType: 'workorder' }],
    });
    staff = await h.as([PERM.create, PERM.fill, PERM.sign, PERM.countersign, PERM.read, PERM.void]);
  });
  afterEach(async () => {
    await h.close();
  });

  const defineTemplate = (key = 'self-inspection', content = CONTENT) =>
    staff.invoke<ProtocolTemplateRow>('protocol/define-template', {
      key,
      title: 'Self-inspection',
      content,
    });

  const instantiate = (templateKey = 'self-inspection') =>
    staff.invoke<ProtocolInstanceRow>('protocol/instantiate', {
      templateKey,
      entityType: BIKE.entityType,
      entityId: BIKE.entityId,
    });

  // -- templates version immutably -----------------------------------------

  it('redefining a template makes a NEW version and never touches the old row', async () => {
    const v1 = await defineTemplate();
    expect(v1.version).toBe(1);

    const v2 = await defineTemplate('self-inspection', {
      sections: [{ title: 'Broms', items: [{ key: 'front-brake', label: 'Frambroms', type: 'check' }] }],
    });
    expect(v2.version).toBe(2);
    expect(v2.id).not.toBe(v1.id); // the v1 row still exists, untouched
  });

  it('an instance pins the template version it was created from', async () => {
    await defineTemplate();
    const inst = await instantiate();
    expect(inst.template_version).toBe(1);

    // Editing the template afterwards must not retro-change the instance.
    await defineTemplate('self-inspection', {
      sections: [{ title: 'Ny', items: [{ key: 'other', label: 'Annat', type: 'check' }] }],
    });
    const again = await staff.invoke<{ instance: ProtocolInstanceRow }>('protocol/get', {
      instanceId: inst.id,
    });
    expect(again.instance.template_version).toBe(1);
  });

  // -- the sign → immutable invariant --------------------------------------

  it('sign freezes the protocol: no further fill is accepted', async () => {
    await defineTemplate();
    const inst = await instantiate();
    await staff.invoke('protocol/fill', { instanceId: inst.id, itemKey: 'front-brake', value: true });

    await staff.invoke('protocol/sign', { instanceId: inst.id });

    await expect(
      staff.invoke('protocol/fill', { instanceId: inst.id, itemKey: 'pad-mm', value: '3.5' }),
    ).rejects.toThrow();
  });

  it('cannot sign twice — signing is once', async () => {
    await defineTemplate();
    const inst = await instantiate();
    await staff.invoke('protocol/sign', { instanceId: inst.id });
    await expect(staff.invoke('protocol/sign', { instanceId: inst.id })).rejects.toThrow(
      /only an open protocol can be signed/,
    );
  });

  it('sign emits protocol.signed with the content hash', async () => {
    await defineTemplate();
    const inst = await instantiate();
    await staff.invoke('protocol/fill', { instanceId: inst.id, itemKey: 'front-brake', value: true });
    await staff.invoke('protocol/sign', { instanceId: inst.id });

    const [evt] = h.eventsOfType('protocol.signed');
    expect(evt).toBeDefined();
    expect(evt!.schemaVersion).toBe(1);
  });

  // -- the content hash is the tamper evidence ------------------------------

  it('refuses a second open instance of one template on one entity', async () => {
    await defineTemplate();
    await instantiate();
    await expect(instantiate()).rejects.toThrow(/already open/);
  });

  /** Sign a fresh instance on its own entity, answering `value`. */
  const signWith = async (entityId: string, value: boolean | string) => {
    const inst = await staff.invoke<ProtocolInstanceRow>('protocol/instantiate', {
      templateKey: 'self-inspection',
      entityType: 'workorder',
      entityId,
    });
    await staff.invoke('protocol/fill', { instanceId: inst.id, itemKey: 'front-brake', value });
    return staff.invoke<SignResult>('protocol/sign', { instanceId: inst.id });
  };

  it('the content hash covers the RESPONSES — different answers, different hash', async () => {
    // The hash is the tamper evidence on a compliance artifact. If "brake OK"
    // and "brake NOT OK" hashed alike, the signature would attest to nothing.
    await defineTemplate();
    const passed = await signWith('01JWORKORDER000000000000001', true);
    const failed = await signWith('01JWORKORDER000000000000002', false);

    expect(passed.signature.content_hash).not.toBe(failed.signature.content_hash);
    expect(passed.signature.content_hash).toMatch(/^[0-9a-f]{64}$/); // SHA-256, hex
  });

  it('the content hash is identical for identical content — it is a function of the content', async () => {
    await defineTemplate();
    const a = await signWith('01JWORKORDER000000000000001', true);
    const b = await signWith('01JWORKORDER000000000000002', true);
    expect(a.signature.content_hash).toBe(b.signature.content_hash);
  });

  it('the content hash covers the TEMPLATE VERSION, not just the answers', async () => {
    // Same answer against a different template version must not attest alike —
    // otherwise a template edit could silently relabel what was signed.
    await defineTemplate();
    const v1 = await signWith('01JWORKORDER000000000000001', true);

    await defineTemplate('self-inspection', {
      sections: [
        {
          title: 'Broms',
          items: [
            { key: 'front-brake', label: 'Frambroms (reviderad)', type: 'check' as const },
            { key: 'pad-mm', label: 'Belägg', type: 'value' as const, unit: 'mm' },
          ],
        },
      ],
    });
    const v2 = await signWith('01JWORKORDER000000000000002', true);

    expect(v1.signature.content_hash).not.toBe(v2.signature.content_hash);
  });

  // -- the requireSigned guard ---------------------------------------------

  it('requireSigned throws while the protocol is open and passes once signed', async () => {
    await defineTemplate();
    const inst = await instantiate();

    await expect(h.run((ctx) => requireSigned(ctx, BIKE, 'self-inspection'))).rejects.toThrow();

    await staff.invoke('protocol/sign', { instanceId: inst.id });
    await expect(h.run((ctx) => requireSigned(ctx, BIKE, 'self-inspection'))).resolves.toBeUndefined();
  });

  // -- void -----------------------------------------------------------------

  it('void records a reason and takes the protocol out of play', async () => {
    await defineTemplate();
    const inst = await instantiate();
    const voided = await staff.invoke<ProtocolInstanceRow>('protocol/void', {
      instanceId: inst.id,
      reason: 'fel cykel',
    });
    expect(voided.status).toBe('voided');
    await expect(staff.invoke('protocol/sign', { instanceId: inst.id })).rejects.toThrow(
      /only an open protocol can be signed/,
    );
  });

  // -- permissions ----------------------------------------------------------

  it('is default-deny: a principal with no permissions does nothing', async () => {
    const nobody = await h.as([]);
    await expect(nobody.invoke('protocol/list-templates')).rejects.toThrow(/permission denied/);
  });

  it('separates fill from sign: a filler cannot sign', async () => {
    await defineTemplate();
    const inst = await instantiate();
    const filler = await h.as([PERM.read, PERM.fill]);
    await filler.invoke('protocol/fill', { instanceId: inst.id, itemKey: 'front-brake', value: true });
    await expect(filler.invoke('protocol/sign', { instanceId: inst.id })).rejects.toThrow(
      /permission denied/,
    );
  });

  it('separates sign from countersign — the second pair of eyes is a different key', async () => {
    await defineTemplate();
    const inst = await instantiate();
    const signer = await h.as([PERM.read, PERM.sign]);
    await signer.invoke('protocol/sign', { instanceId: inst.id });
    await expect(signer.invoke('protocol/countersign', { instanceId: inst.id })).rejects.toThrow(
      /permission denied/,
    );
  });
});
