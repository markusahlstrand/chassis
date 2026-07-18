import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { dataSubjectId, moneyOf } from '@substrat-run/contracts';
import { engineHarness, type EngineHarness } from '@substrat-run/engine-test-kit';
import {
  PERM,
  SlotUnavailable,
  availability,
  bookingModule,
  cancelReservation,
  completeReservation,
  confirmReservation,
  createResource,
  expireReservation,
  holdReservation,
  joinReservation,
  leaveReservation,
  type FreeInterval,
  type Reservation,
  type Resource,
} from '../src/index.js';

/**
 * The reservation engine, tested directly.
 *
 * Every test pins `now` explicitly rather than leaning on the wall clock, so the
 * suite is deterministic and does not rot when the fixture dates fall into the
 * past.
 */

const NOW = '2026-07-20T12:00:00.000Z';
const EXPIRES = '2026-07-20T12:10:00.000Z';
const AFTER_EXPIRY = '2026-07-20T12:11:00.000Z';

const T17 = '2026-07-20T17:00:00.000Z';
const T1830 = '2026-07-20T18:30:00.000Z';
const T19 = '2026-07-20T19:00:00.000Z';
const T2030 = '2026-07-20T20:30:00.000Z';

/**
 * Participants are data subjects, so `partyRef` is a ULID-shaped DataSubjectId —
 * it keys crypto-shredding. Crockford base32 excludes I, L, O and U.
 */
const player = (n: number) => dataSubjectId.parse(`01JPADEK${'A'.repeat(17)}${n}`);

describe('engine-booking', () => {
  let h: EngineHarness;
  let staff: Awaited<ReturnType<EngineHarness['as']>>;

  beforeEach(async () => {
    h = await engineHarness({ modules: [bookingModule] });
    staff = await h.as([
      PERM.create,
      PERM.read,
      PERM.hold,
      PERM.confirm,
      PERM.cancel,
      PERM.complete,
      PERM.manageResources,
    ]);
  });
  afterEach(async () => {
    await h.close();
  });

  const court = (name = 'Bana 1', capacity?: number) =>
    h.run((ctx) => createResource(ctx, { kind: 'court', name, capacity }));

  const hold = (
    resourceId: string,
    startsAt = T17,
    endsAt = T1830,
    extra: Record<string, unknown> = {},
  ) =>
    h.run((ctx) =>
      holdReservation(ctx, { resourceId, startsAt, endsAt, expiresAt: EXPIRES, now: NOW, ...extra }),
    );

  // -- resources -----------------------------------------------------------

  it('creates a court with capacity 1 by default', async () => {
    const r = await court();
    expect(r.capacity).toBe(1);
    expect(r.active).toBe(true);
    expect(h.eventsOfType('booking.resource-created')).toHaveLength(1);
  });

  // -- the allocation invariant -------------------------------------------

  it('holds a free slot and confirms it', async () => {
    const r = await court();
    const held = await hold(r.id);
    expect(held.state).toBe('held');
    expect(held.expiresAt).toBe(EXPIRES);

    const confirmed = await h.run((ctx) =>
      confirmReservation(ctx, { reservationId: held.id, now: NOW }),
    );
    expect(confirmed.state).toBe('confirmed');
    expect(confirmed.expiresAt).toBeNull();
    expect(h.eventsOfType('booking.confirmed')).toHaveLength(1);
  });

  it('rejects an overlapping hold with SlotUnavailable — no lock involved', async () => {
    const r = await court();
    await hold(r.id);
    await expect(hold(r.id)).rejects.toThrow(SlotUnavailable);
  });

  it('rejects a partial overlap, not just an exact one', async () => {
    const r = await court();
    await hold(r.id, T17, T19);
    await expect(hold(r.id, T1830, T2030)).rejects.toThrow(SlotUnavailable);
  });

  it('treats intervals as HALF-OPEN: back-to-back bookings do not collide', async () => {
    const r = await court();
    await hold(r.id, T17, T1830);
    const next = await hold(r.id, T1830, T19); // starts exactly where the last ends
    expect(next.state).toBe('held');
  });

  it('compares instants by moment, not by string — an offset and a Z collide', async () => {
    const r = await court();
    await hold(r.id, T17, T1830); // 17:00Z–18:30Z
    // 19:00+02:00 IS 17:00Z. A naive lexicographic compare would miss this.
    await expect(
      hold(r.id, '2026-07-20T19:00:00+02:00', '2026-07-20T20:30:00+02:00'),
    ).rejects.toThrow(SlotUnavailable);
  });

  it('frees the slot lazily once a hold expires — no sweep required', async () => {
    const r = await court();
    await hold(r.id);
    await expect(hold(r.id)).rejects.toThrow(SlotUnavailable);

    // Same slot, but asked for after the hold's deadline.
    const later = await h.run((ctx) =>
      holdReservation(ctx, {
        resourceId: r.id,
        startsAt: T17,
        endsAt: T1830,
        expiresAt: '2026-07-20T12:20:00.000Z',
        now: AFTER_EXPIRY,
      }),
    );
    expect(later.state).toBe('held');
  });

  it('refuses to confirm a hold that has expired', async () => {
    const r = await court();
    const held = await hold(r.id);
    await expect(
      h.run((ctx) => confirmReservation(ctx, { reservationId: held.id, now: AFTER_EXPIRY })),
    ).rejects.toThrow(/expired/);
  });

  it('expireReservation moves held → expired and emits', async () => {
    const r = await court();
    const held = await hold(r.id);
    const expired = await h.run((ctx) =>
      expireReservation(ctx, { reservationId: held.id, now: AFTER_EXPIRY }),
    );
    expect(expired.state).toBe('expired');
    expect(h.eventsOfType('booking.expired')).toHaveLength(1);
  });

  it('will not expire a hold that is still alive', async () => {
    const r = await court();
    const held = await hold(r.id);
    await expect(
      h.run((ctx) => expireReservation(ctx, { reservationId: held.id, now: NOW })),
    ).rejects.toThrow(/not expired yet/);
  });

  it('rejects a hold whose deadline is already past', async () => {
    const r = await court();
    await expect(
      h.run((ctx) =>
        holdReservation(ctx, {
          resourceId: r.id,
          startsAt: T17,
          endsAt: T1830,
          expiresAt: NOW,
          now: AFTER_EXPIRY,
        }),
      ),
    ).rejects.toThrow(/already be expired/);
  });

  it('rejects an inverted interval', async () => {
    const r = await court();
    await expect(hold(r.id, T1830, T17)).rejects.toThrow();
  });

  it('rejects booking an inactive resource', async () => {
    const r = await court();
    await staff.invoke('booking/set-resource-active', { resourceId: r.id, active: false });
    await expect(hold(r.id)).rejects.toThrow(/inactive/);
  });

  // -- capacity > 1 (fungible pools) --------------------------------------

  it('allows concurrent allocations up to capacity, then rejects', async () => {
    const rackets = await court('Racketpool', 3);
    await hold(rackets.id);
    await hold(rackets.id);
    await hold(rackets.id);
    await expect(hold(rackets.id)).rejects.toThrow(SlotUnavailable);
  });

  it('counts quantity, not just rows, against capacity', async () => {
    const rackets = await court('Racketpool', 3);
    await hold(rackets.id, T17, T1830, { quantity: 2 });
    await expect(hold(rackets.id, T17, T1830, { quantity: 2 })).rejects.toThrow(SlotUnavailable);
    const ok = await hold(rackets.id, T17, T1830, { quantity: 1 });
    expect(ok.state).toBe('held');
  });

  // -- the open match: fill target auto-confirms ---------------------------

  it('auto-confirms when the fill target is reached — the open-match mechanic', async () => {
    const r = await court();
    const match = await hold(r.id, T17, T1830, { fillTarget: 4 });

    const join = (partyRef: ReturnType<typeof player>) =>
      h.run((ctx) =>
        joinReservation(ctx, {
          reservationId: match.id,
          partyRef,
          share: moneyOf('120', 'SEK'),
          now: NOW,
        }),
      );

    for (const p of [player(1), player(2), player(3)]) {
      const { reservation } = await join(p);
      expect(reservation.state).toBe('held'); // still filling
    }

    const { reservation } = await join(player(4));
    expect(reservation.state).toBe('confirmed'); // the 4th tips it
    expect(h.eventsOfType('booking.participant-joined')).toHaveLength(4);
    expect(h.eventsOfType('booking.confirmed')).toHaveLength(1);
  });

  it('refuses a duplicate party and a full match', async () => {
    const r = await court();
    const match = await hold(r.id, T17, T1830, { fillTarget: 2 });
    const join = (partyRef: ReturnType<typeof player>) =>
      h.run((ctx) => joinReservation(ctx, { reservationId: match.id, partyRef, now: NOW }));

    await join(player(1));
    await expect(join(player(1))).rejects.toThrow(/already joined/);
    await join(player(2)); // fills and confirms
    await expect(join(player(3))).rejects.toThrow(/full/);
  });

  it('leaving is a soft record — the row survives and the count drops', async () => {
    const r = await court();
    const match = await hold(r.id, T17, T1830, { fillTarget: 4 });
    const { participant } = await h.run((ctx) =>
      joinReservation(ctx, { reservationId: match.id, partyRef: player(1), now: NOW }),
    );
    await h.run((ctx) =>
      leaveReservation(ctx, {
        reservationId: match.id,
        participantId: participant.id,
        now: NOW,
      }),
    );

    const { participants } = await staff.invoke<{ participants: { leftAt: string | null }[] }>(
      'booking/get',
      { reservationId: match.id },
    );
    expect(participants).toHaveLength(1); // not deleted
    expect(participants[0]!.leftAt).toBe(NOW);
    expect(h.eventsOfType('booking.participant-left')).toHaveLength(1);
  });

  // -- the state machine cannot skip --------------------------------------

  it('cannot complete a reservation that was never confirmed', async () => {
    const r = await court();
    const held = await hold(r.id);
    await expect(
      h.run((ctx) => completeReservation(ctx, { reservationId: held.id })),
    ).rejects.toThrow(/invalid transition/);
  });

  it('cannot cancel a completed reservation', async () => {
    const r = await court();
    const held = await hold(r.id);
    await h.run((ctx) => confirmReservation(ctx, { reservationId: held.id, now: NOW }));
    await h.run((ctx) => completeReservation(ctx, { reservationId: held.id }));
    await expect(
      h.run((ctx) => cancelReservation(ctx, { reservationId: held.id })),
    ).rejects.toThrow(/invalid transition/);
  });

  it('a cancelled slot becomes bookable again', async () => {
    const r = await court();
    const held = await hold(r.id);
    await h.run((ctx) => confirmReservation(ctx, { reservationId: held.id, now: NOW }));
    await expect(hold(r.id)).rejects.toThrow(SlotUnavailable);

    await h.run((ctx) => cancelReservation(ctx, { reservationId: held.id }));
    const again = await hold(r.id);
    expect(again.state).toBe('held');
  });

  // -- the fat completion event -------------------------------------------

  const playedMatch = async () => {
    const r = await court();
    const match = await hold(r.id, T17, T1830, { fillTarget: 2 });
    for (const n of [1, 2]) {
      await h.run((ctx) =>
        joinReservation(ctx, {
          reservationId: match.id,
          partyRef: player(n),
          share: moneyOf('120', 'SEK'),
          now: NOW,
        }),
      );
    }
    await h.run((ctx) => completeReservation(ctx, { reservationId: match.id }));
    return match;
  };

  it('completion carries the business facts and NO participant identities', async () => {
    await playedMatch();

    const [evt] = h.eventsOfType('booking.completed');
    const payload = evt!.payload as Record<string, unknown> & {
      resource: { name: string };
      startsAt: string;
      participantCount: number;
    };
    expect(evt!.schemaVersion).toBe(1);
    expect(payload.resource.name).toBe('Bana 1');
    expect(payload.startsAt).toBe(T17);
    expect(payload.participantCount).toBe(2);

    // The club's business record survives an erasure: it names no one.
    expect(JSON.stringify(payload)).not.toContain(player(1));
    expect(payload.participants).toBeUndefined();
  });

  it('the roster travels per-participant, each keyed to its own data subject', async () => {
    await playedMatch();

    const joined = h.eventsOfType('booking.participant-joined');
    expect(joined).toHaveLength(2);
    // These carry piiClass 'pseudonymous'; the kernel REJECTS such an event without
    // a subjectId, so the fact they emitted at all proves the erasure key is set.
    const payload = joined[0]!.payload as { partyRef: string; share: { amount: string } };
    expect(payload.partyRef).toBe(player(1));
    expect(payload.share.amount).toBe('120');
  });

  // -- availability --------------------------------------------------------

  it('reports the gaps around a booking', async () => {
    const r = await court();
    const held = await hold(r.id, T17, T1830);
    await h.run((ctx) => confirmReservation(ctx, { reservationId: held.id, now: NOW }));

    const free = await h.run((ctx) =>
      availability(ctx, { resourceId: r.id, from: NOW, to: T2030, now: NOW }),
    );
    expect(free).toEqual<FreeInterval[]>([
      { startsAt: NOW, endsAt: T17, available: 1 },
      { startsAt: T1830, endsAt: T2030, available: 1 },
    ]);
  });

  it('reports remaining capacity on a pool rather than a boolean', async () => {
    const pool = await court('Racketpool', 3);
    await hold(pool.id, T17, T1830, { quantity: 2 });

    const free = await h.run((ctx) =>
      availability(ctx, { resourceId: pool.id, from: T17, to: T1830, now: NOW }),
    );
    expect(free).toEqual<FreeInterval[]>([{ startsAt: T17, endsAt: T1830, available: 1 }]);
  });

  it('ignores expired holds when reporting availability', async () => {
    const r = await court();
    await hold(r.id, T17, T1830);
    const free = await h.run((ctx) =>
      availability(ctx, { resourceId: r.id, from: T17, to: T1830, now: AFTER_EXPIRY }),
    );
    expect(free).toEqual<FreeInterval[]>([{ startsAt: T17, endsAt: T1830, available: 1 }]);
  });

  // -- permissions ---------------------------------------------------------

  it('refuses every operation to a principal holding nothing', async () => {
    const r = await court();
    const nobody = await h.as([]);
    await expect(nobody.invoke('booking/list')).rejects.toThrow(/permission denied/);
    await expect(
      nobody.invoke('booking/hold', {
        resourceId: r.id,
        startsAt: T17,
        endsAt: T1830,
        expiresAt: EXPIRES,
        now: NOW,
      }),
    ).rejects.toThrow(/permission denied/);
  });

  it('separates holding from managing resources', async () => {
    const booker = await h.as([PERM.read, PERM.hold]);
    await expect(
      booker.invoke('booking/create-resource', { kind: 'court', name: 'Bana 9' }),
    ).rejects.toThrow(/permission denied/);
  });

  it('registers operations that round-trip through the kernel', async () => {
    const r = await staff.invoke<Resource>('booking/create-resource', {
      kind: 'court',
      name: 'Bana 2',
    });
    const held = await staff.invoke<Reservation>('booking/hold', {
      resourceId: r.id,
      startsAt: T17,
      endsAt: T1830,
      expiresAt: EXPIRES,
      now: NOW,
    });
    const confirmed = await staff.invoke<Reservation>('booking/confirm', {
      reservationId: held.id,
      now: NOW,
    });
    expect(confirmed.state).toBe('confirmed');

    const list = await staff.invoke<Reservation[]>('booking/list', { resourceId: r.id });
    expect(list).toHaveLength(1);
  });
});
