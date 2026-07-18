import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { ScopeStub } from '@substrat-run/kernel';
import type { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import type { Money } from '@substrat-run/contracts';
import type { Reservation } from '@substrat-run/engine-booking';
import {
  buildRallyHost,
  seedRally,
  zonedToInstant,
  type MemberRow,
  type RallyWorld,
  type SlotFit,
} from '../src/index.js';

/**
 * The RallyPoint scenario (spec/concept.md §11): provision → venue hours →
 * priced booking → the lost race → hold expiry → maintenance → open match →
 * portal isolation → the cross-tenant attack.
 *
 * Every clock-sensitive step pins `now`, so the suite is deterministic and does
 * not rot when the fixture dates fall into the past.
 */
describe('RallyPoint demo scenario (spec §11)', () => {
  let dir: string;
  let host: SqliteScopeHost;
  let w: RallyWorld;
  let astrid: ScopeStub; // club-admin
  let ravi: ScopeStub; // receptionist @ Solna
  let nils: ScopeStub; // coach

  // 2026-07-20 is inside CEST (UTC+2), so 19:00 local is 17:00Z.
  const DATE = '2026-07-20';
  const NOW = '2026-07-20T06:00:00.000Z';
  const LATER = '2026-07-20T06:11:00.000Z'; // past a 10-minute hold

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-rally-'));
    host = buildRallyHost(dir);
    w = await seedRally(host, dir);
    astrid = await host.getScope(w.astrid, w.t1, w.s1);
    ravi = await host.getScope(w.ravi, w.t1, w.s1);
    nils = await host.getScope(w.nils, w.t1, w.s1);
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
      '@substrat-run/demo-rally',
      '@substrat-run/engine-booking',
      '@substrat-run/engine-invoicing',
    ]);
  });

  it('2. converts local wall time to an instant across the DST offset', () => {
    // The engine is timezone-free; this conversion is the vertical's whole job.
    expect(zonedToInstant(DATE, '19:00', 'Europe/Stockholm')).toBe('2026-07-20T17:00:00.000Z');
    // Winter, the same wall clock is UTC+1.
    expect(zonedToInstant('2026-01-20', '19:00', 'Europe/Stockholm')).toBe(
      '2026-01-20T18:00:00.000Z',
    );
  });

  it('3. availability reports which durations actually fit each start', async () => {
    const slots = await ravi.invoke<SlotFit[]>('rally/availability', {
      resourceId: w.court1,
      date: DATE,
      now: NOW,
    });
    expect(slots.length).toBeGreaterThan(0);
    // An empty court opens at 07:00 local and every duration fits.
    expect(slots[0]!.startsAt).toBe(zonedToInstant(DATE, '07:00', 'Europe/Stockholm'));
    expect(slots[0]!.fits).toEqual([60, 90, 120]);
    // Bana 2 is configured 90-only-and-under, so 120 never appears.
    const bana2 = await ravi.invoke<SlotFit[]>('rally/availability', {
      resourceId: w.court2,
      date: DATE,
      now: NOW,
    });
    expect(bana2[0]!.fits).toEqual([60, 90]);
  });

  it('4. ravi books a peak slot: rule + tier resolve to the öre', async () => {
    const booked = await ravi.invoke<{
      reservation: Reservation;
      price: Money;
      ruleLabel: string;
    }>('rally/book-court', {
      resourceId: w.court1,
      memberId: w.elinId,
      date: DATE,
      time: '19:00',
      duration: 90,
      now: NOW,
    });
    expect(booked.reservation.state).toBe('held');
    expect(booked.reservation.startsAt).toBe('2026-07-20T17:00:00.000Z');
    // Peak 340 kr − Member 10% = 306 kr. Duration is an input, not a multiplier.
    expect(booked.price.amount).toBe('306');
    expect(booked.ruleLabel).toContain('Peak');

    const confirmed = await ravi.invoke<{ reservation: Reservation }>('rally/confirm-booking', {
      reservationId: booked.reservation.id,
      now: NOW,
    });
    expect(confirmed.reservation.state).toBe('confirmed');
  });

  it('5. THE LOST RACE: the second booking of the same slot is refused', async () => {
    await expect(
      ravi.invoke('rally/book-court', {
        resourceId: w.court1,
        memberId: w.johanId,
        date: DATE,
        time: '19:00',
        duration: 90,
        now: NOW,
      }),
    ).rejects.toThrow(/slot unavailable/i);
  });

  it('6. availability now shows the booked window gone', async () => {
    const slots = await ravi.invoke<SlotFit[]>('rally/availability', {
      resourceId: w.court1,
      date: DATE,
      now: NOW,
    });
    const at19 = slots.find((s) => s.startsAt === '2026-07-20T17:00:00.000Z');
    expect(at19).toBeUndefined();
  });

  it('7. a hold that expires frees the slot again — no sweep', async () => {
    const held = await ravi.invoke<{ reservation: Reservation }>('rally/book-court', {
      resourceId: w.court2,
      memberId: w.johanId,
      date: DATE,
      time: '09:00',
      duration: 60,
      now: NOW,
    });
    expect(held.reservation.state).toBe('held');

    // Same slot, asked for after the 10-minute hold lapsed.
    const second = await ravi.invoke<{ reservation: Reservation }>('rally/book-court', {
      resourceId: w.court2,
      memberId: w.elinId,
      date: DATE,
      time: '09:00',
      duration: 60,
      now: LATER,
    });
    expect(second.reservation.state).toBe('held');
  });

  it('8. bookings outside the opening window are refused by the vertical', async () => {
    await expect(
      ravi.invoke('rally/book-court', {
        resourceId: w.court1,
        memberId: w.elinId,
        date: DATE,
        time: '05:00', // club opens 07:00
        duration: 60,
        now: NOW,
      }),
    ).rejects.toThrow(/outside opening hours/);
  });

  it('9. a duration the court does not offer is refused', async () => {
    await expect(
      ravi.invoke('rally/book-court', {
        resourceId: w.court2, // 60/90 only
        memberId: w.elinId,
        date: DATE,
        time: '12:00',
        duration: 120,
        now: NOW,
      }),
    ).rejects.toThrow(/not bookable on this court/);
  });

  it('10. a closure shuts the day, and the calendar agrees', async () => {
    await astrid.invoke('rally/add-closure', {
      onDate: '2026-07-21',
      reason: 'Klubbmästerskap',
    });
    const slots = await ravi.invoke<SlotFit[]>('rally/availability', {
      resourceId: w.court1,
      date: '2026-07-21',
      now: NOW,
    });
    expect(slots).toEqual([]);
    await expect(
      ravi.invoke('rally/book-court', {
        resourceId: w.court1, memberId: w.elinId, date: '2026-07-21',
        time: '19:00', duration: 90, now: NOW,
      }),
    ).rejects.toThrow(/closed/);
  });

  it('11. maintenance blocks the court through the SAME overlap invariant', async () => {
    await astrid.invoke('rally/block-maintenance', {
      resourceId: w.court1,
      date: DATE,
      time: '13:00',
      duration: 120,
      reason: 'Omslipning',
      now: NOW,
    });
    await expect(
      ravi.invoke('rally/book-court', {
        resourceId: w.court1, memberId: w.elinId, date: DATE,
        time: '13:00', duration: 60, now: NOW,
      }),
    ).rejects.toThrow(/slot unavailable/i);
  });

  it('12. an open match fills and auto-confirms on the last join', async () => {
    const match = await astrid.invoke<{
      reservation: Reservation;
      price: Money;
      sharePerPlayer: Money;
    }>('rally/create-open-match', {
      resourceId: w.court1,
      memberId: w.elinId,
      date: DATE,
      time: '20:30',
      duration: 90,
      fillTarget: 2,
      levelMin: '3.0',
      levelMax: '4.0',
      now: NOW,
    });
    expect(match.reservation.state).toBe('held');
    expect(match.reservation.fillTarget).toBe(2);
    expect(match.sharePerPlayer.amount).toBe('153'); // 306 / 2

    const first = await astrid.invoke<{ reservation: Reservation }>('rally/join-match', {
      reservationId: match.reservation.id, memberId: w.elinId, now: NOW,
    });
    expect(first.reservation.state).toBe('held'); // still filling

    const second = await astrid.invoke<{ reservation: Reservation }>('rally/join-match', {
      reservationId: match.reservation.id, memberId: w.johanId, now: NOW,
    });
    expect(second.reservation.state).toBe('confirmed'); // the 2nd tips it
  });

  it('13. the level band is vertical policy and it holds', async () => {
    const match = await astrid.invoke<{ reservation: Reservation }>('rally/create-open-match', {
      resourceId: w.court2, memberId: w.elinId, date: DATE,
      time: '15:00', duration: 60, fillTarget: 2,
      levelMin: '4.5', levelMax: '6.0', now: NOW,
    });
    // Elin is 3.4 — below her own match's band.
    await expect(
      astrid.invoke('rally/join-match', {
        reservationId: match.reservation.id, memberId: w.elinId, now: NOW,
      }),
    ).rejects.toThrow(/outside the band/);
  });

  it('14. the denials hold: coach, receptionist, and the cross-tenant attacker', async () => {
    // A coach may read the calendar but never take a booking.
    await expect(
      nils.invoke('rally/book-court', {
        resourceId: w.court1, memberId: w.elinId, date: DATE,
        time: '11:00', duration: 60, now: NOW,
      }),
    ).rejects.toThrow(/permission denied/);

    // A receptionist takes bookings but does not re-cut the club's hours.
    await expect(
      ravi.invoke('rally/set-hours', { weekday: 3, opensAt: '06:00', closesAt: '23:00' }),
    ).rejects.toThrow(/permission denied/);
    await expect(
      ravi.invoke('booking/create-resource', { kind: 'court', name: 'Smygbana' }),
    ).rejects.toThrow(/permission denied/);

    // Ravi holds a role at Solna only — Nacka is not his.
    await expect(host.getScope(w.ravi, w.t1, w.s1b)).resolves.toBeDefined();
    const raviNacka = await host.getScope(w.ravi, w.t1, w.s1b);
    await expect(raviNacka.invoke('rally/list-members')).rejects.toThrow(/permission denied/);

    // Rutger runs another club. Claiming RallyPoint's scope under his own tenant
    // is not a permission failure — the scope does not exist for him at all.
    await expect(host.getScope(w.rutger, w.t2, w.s1)).rejects.toThrow(/unknown scope/);
    const rutger = await host.getScope(w.rutger, w.t2, w.s2);
    await expect(rutger.invoke('rally/list-members')).resolves.toEqual([]);
  });

  it('15. the coach read is the WHOLE calendar — deliberate, not an oversight', async () => {
    // Accepted at the permission checkpoint (spec §9): a coach holds plain
    // booking:read, so they see every court and every booking — not only their
    // own lessons. Pinned here so narrowing it later is a visible, tested change
    // rather than a silent one.
    const coachSees = await nils.invoke<Reservation[]>('rally/portal-bookings', { now: NOW });
    const staffSees = await astrid.invoke<Reservation[]>('rally/portal-bookings', { now: NOW });
    expect(coachSees.length).toBe(staffSees.length);
    expect(coachSees.length).toBeGreaterThan(0);

    // Read-only, though: no writes of any kind.
    await expect(
      nils.invoke('rally/create-member', { partyRef: w.johanParty, name: 'Smyg' }),
    ).rejects.toThrow(/permission denied/);
  });

  it('16. portal isolation: a player sees their own booking and no one else’s', async () => {
    const elin = await host.getScope(w.elin, w.t1, w.s1);
    const johan = await host.getScope(w.johan, w.t1, w.s1);

    const elinsBookings = await elin.invoke<Reservation[]>('rally/portal-bookings', { now: NOW });
    const johansBookings = await johan.invoke<Reservation[]>('rally/portal-bookings', { now: NOW });

    // Both must be non-empty, or "no overlap" would be vacuously true.
    expect(elinsBookings.length).toBeGreaterThan(0);
    expect(johansBookings.length).toBeGreaterThan(0);
    const elinIds = new Set(elinsBookings.map((r) => r.id));
    for (const r of johansBookings) expect(elinIds.has(r.id)).toBe(false);

    // Neither sees the club's full book: staff see strictly more.
    const all = await astrid.invoke<Reservation[]>('rally/portal-bookings', { now: NOW });
    expect(all.length).toBeGreaterThan(elinsBookings.length + johansBookings.length - 1);

    // And the portal principal cannot reach staff surfaces at all.
    await expect(elin.invoke('rally/list-members')).rejects.toThrow(/permission denied/);
    await expect(elin.invoke('rally/set-hours', { weekday: 1 })).rejects.toThrow(
      /permission denied/,
    );
  });

  it('17. the state machine cannot skip', async () => {
    const booked = await ravi.invoke<{ reservation: Reservation }>('rally/book-court', {
      resourceId: w.court1, memberId: w.elinId, date: DATE,
      time: '08:00', duration: 60, now: NOW,
    });
    await ravi.invoke('rally/confirm-booking', {
      reservationId: booked.reservation.id, now: NOW,
    });
    await expect(
      ravi.invoke('rally/confirm-booking', { reservationId: booked.reservation.id, now: NOW }),
    ).rejects.toThrow(/invalid transition/);
  });

  it('18. members are the vertical’s vocabulary, keyed to a global player ref', async () => {
    const members = await astrid.invoke<MemberRow[]>('rally/list-members');
    expect(members.map((m) => m.name).sort()).toEqual(['Elin Kastberg', 'Johan Ek']);
    expect(members.find((m) => m.name === 'Elin Kastberg')!.party_ref).toBe(w.elinParty);
  });
});
