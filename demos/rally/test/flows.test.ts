import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Hono } from 'hono';
import type { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { buildRallyHost, seedRally, type RallyWorld } from '../src/index.js';
import { createRallyApp } from '../src/app.js';

/**
 * The flows, walked end to end through the REAL HTTP routes.
 *
 * scenario.test.ts calls operations directly, which is the right way to pin
 * invariants — and is structurally blind to the bugs this demo has actually
 * shipped. Every one of them was a wiring bug: an operation that worked with no
 * route in front of it, a link nothing read, a button with no path behind it.
 * A test that reaches for `ctx` cannot see any of that; one that goes through
 * the app can.
 *
 * The last test in this file is the important one: it fails if a registered
 * route is never exercised here, so "shipped but unreachable" becomes a red
 * build rather than something the user finds by clicking.
 */

const seen = new Set<string>();

describe('RallyPoint flows (through the HTTP surface)', () => {
  let dir: string;
  let host: SqliteScopeHost;
  let app: Hono;
  let w: RallyWorld;

  /** A date safely in the future, so holds and windows behave like the real app. */
  const soon = (plusDays = 10): string => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + plusDays);
    return d.toISOString().slice(0, 10);
  };
  const DATE = soon();

  const call = async (
    path: string,
    opts: { as?: string; venue?: string; method?: string; body?: unknown } = {},
  ): Promise<{ status: number; body: any }> => {
    seen.add(`${opts.method ?? 'GET'} ${path.split('?')[0]!.replace(/\/[0-9A-HJKMNP-TV-Z]{26}/g, '/:id')}`);
    const res = await app.request(path, {
      method: opts.method ?? 'GET',
      headers: {
        'content-type': 'application/json',
        ...(opts.as ? { 'x-principal': opts.as } : {}),
        ...(opts.venue ? { 'x-venue': opts.venue } : {}),
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  const ok = async (path: string, opts: Parameters<typeof call>[1] = {}) => {
    const r = await call(path, opts);
    expect({ path, status: r.status, body: r.body }).toMatchObject({ status: 200 });
    return r.body;
  };

  let astrid: string;
  let ravi: string;
  let nils: string;
  let elin: string;
  let johan: string;
  let rutger: string;
  let elinM: string;
  let johanM: string;
  let court: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-rally-flows-'));
    host = buildRallyHost(dir);
    w = await seedRally(host, dir);
    app = createRallyApp(host, w);

    const cast = await ok('/api/cast');
    astrid = cast.cast.astrid.principal;
    ravi = cast.cast.ravi.principal;
    nils = cast.cast.nils.principal;
    elin = cast.cast.elin.principal;
    johan = cast.cast.johan.principal;
    rutger = cast.cast.rutger.principal;
    elinM = cast.members.solna.elin;
    johanM = cast.members.solna.johan;
    const courts = await ok('/api/courts', { as: astrid });
    court = courts[0].id;
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // -- who can see which club ----------------------------------------------

  it('venue reachability is the permission model, not a UI preference', async () => {
    expect((await ok('/api/my-venues', { as: astrid })).map((v: any) => v.key)).toEqual([
      'solna',
      'nacka',
    ]);
    expect((await ok('/api/my-venues', { as: ravi })).map((v: any) => v.key)).toEqual(['solna']);
    expect((await ok('/api/my-venues', { as: rutger })).map((v: any) => v.key)).toEqual([
      'goteborg',
    ]);
    // Astrid may name Göteborg's scope; she just cannot do anything in it.
    expect((await call('/api/venue', { as: astrid, venue: 'goteborg' })).status).toBe(403);
  });

  // -- the player's whole booking journey ----------------------------------

  it('a player browses, books, and pays — without ever reading the club’s book', async () => {
    const courts = await ok('/api/browse/courts', { as: elin });
    expect(courts.length).toBeGreaterThan(0);

    const slots = await ok(`/api/availability?resourceId=${court}&date=${DATE}`, { as: elin });
    expect(slots.length).toBeGreaterThan(0);
    expect(slots[0].fits.length).toBeGreaterThan(0);

    const booked = await ok('/api/bookings', {
      as: elin,
      method: 'POST',
      body: { resourceId: court, memberId: elinM, date: DATE, time: '19:00', duration: 90 },
    });
    expect(booked.reservation.state).toBe('held');
    expect(booked.price.amount).toBe('340'); // Högtrafik, no customer discount

    const confirmed = await ok(`/api/bookings/${booked.reservation.id}/confirm`, {
      as: elin,
      method: 'POST',
      body: {},
    });
    expect(confirmed.reservation.state).toBe('confirmed');

    // Hers, and only hers.
    const mine = await ok('/api/portal/bookings', { as: elin });
    expect(mine.some((r: any) => r.id === booked.reservation.id)).toBe(true);
    expect((await call('/api/members', { as: elin })).status).toBe(403);
    expect((await call('/api/reservations', { as: elin })).status).toBe(403);
  });

  it('the same slot twice is a 409 the UI can act on', async () => {
    await ok('/api/bookings', {
      as: ravi,
      method: 'POST',
      body: { resourceId: court, memberId: johanM, date: DATE, time: '14:00', duration: 60 },
    });
    const clash = await call('/api/bookings', {
      as: ravi,
      method: 'POST',
      body: { resourceId: court, memberId: elinM, date: DATE, time: '14:00', duration: 60 },
    });
    expect(clash.status).toBe(409);
    expect(clash.body.code).toBe('SLOT_UNAVAILABLE');
  });

  // -- wallet, packs, subscriptions ----------------------------------------

  it('buys credit, pays a booking from it, and subscribes', async () => {
    const bought = await ok('/api/wallet/buy', {
      as: elin,
      method: 'POST',
      body: { memberId: elinM, packKey: 'klipp-5' },
    });
    expect(Number(bought.received.amount)).toBeGreaterThan(Number(bought.paid.amount));

    const b = await ok('/api/bookings', {
      as: elin,
      method: 'POST',
      body: { resourceId: court, memberId: elinM, date: DATE, time: '10:00', duration: 60 },
    });
    const paid = await ok(`/api/bookings/${b.reservation.id}/confirm`, {
      as: elin,
      method: 'POST',
      body: { payWith: 'wallet' },
    });
    expect(paid.paidFromWallet).toBe(true);

    const wallet = await ok(`/api/wallet?memberId=${elinM}`, { as: elin });
    expect(wallet.entries.length).toBe(2); // the pack, then the booking

    const sub = await ok('/api/subscriptions', {
      as: elin,
      method: 'POST',
      body: { memberId: elinM, planKey: 'manadskort', on: DATE },
    });
    const run = await ok('/api/billing/run', { as: astrid, method: 'POST', body: { on: DATE } });
    expect(run.charged).toBe(1);

    // Cancelling stops the next cycle without clawing back what was credited.
    const cancelled = await ok(`/api/subscriptions/${sub.id}/cancel`, {
      as: elin, method: 'POST', body: {},
    });
    expect(cancelled.status).toBe('cancelled');
    const after = await ok('/api/billing/run', {
      as: astrid, method: 'POST', body: { on: soon(45) },
    });
    expect(after.charged).toBe(0);
  });

  // -- open matches, and the shared link -----------------------------------

  it('opens a match, shares the link, and the link fills and then dies', async () => {
    const made = await ok('/api/matches', {
      as: elin,
      method: 'POST',
      body: {
        resourceId: court, memberId: elinM, date: DATE, time: '21:00', duration: 90,
        fillTarget: 2, levelMin: '3.0', levelMax: '4.5',
      },
    });
    const id = made.reservation.id;

    // The host occupies a spot, so it is on offer at 1/2 — not 0/2.
    const list = await ok('/api/matches', { as: johan });
    const offered = list.find((m: any) => m.reservationId === id);
    expect(offered.joined).toBe(1);

    // The link resolves for someone who is not in it yet.
    const landing = await ok(`/api/matches/${id}`, { as: johan });
    expect(landing.status).toBe('open');
    expect(landing.venueName).toContain('Solna');

    await ok(`/api/matches/${id}/join`, { as: johan, method: 'POST', body: { memberId: johanM } });

    // …and the same link now tells the truth to the next person.
    expect((await ok(`/api/matches/${id}`, { as: elin })).status).toBe('full');
    expect((await ok('/api/matches', { as: johan })).some((m: any) => m.reservationId === id)).toBe(
      false,
    );
  });

  // -- what reception does all day -----------------------------------------

  it('reception books, moves, marks a no-show and cancels', async () => {
    const b = await ok('/api/bookings', {
      as: ravi,
      method: 'POST',
      body: { resourceId: court, memberId: johanM, date: DATE, time: '08:00', duration: 60 },
    });
    const id = b.reservation.id;
    await ok(`/api/bookings/${id}/confirm`, { as: ravi, method: 'POST', body: {} });

    const detail = await ok(`/api/reservations/${id}`, { as: ravi });
    expect(detail.reservation.id).toBe(id);

    const moved = await ok(`/api/bookings/${id}/move`, {
      as: ravi,
      method: 'POST',
      body: { startsAt: new Date(Date.parse(b.reservation.startsAt) + 3600_000).toISOString() },
    });
    expect(moved.startsAt).not.toBe(b.reservation.startsAt);

    await ok(`/api/bookings/${id}/players`, {
      as: ravi,
      method: 'POST',
      body: { memberId: elinM },
    });
    await ok(`/api/bookings/${id}/no-show`, { as: ravi, method: 'POST', body: {} });

    const c = await ok('/api/bookings', {
      as: ravi,
      method: 'POST',
      body: { resourceId: court, memberId: johanM, date: DATE, time: '07:00', duration: 60 },
    });
    await ok(`/api/bookings/${c.reservation.id}/cancel`, {
      as: ravi, method: 'POST', body: { reason: 'kund' },
    });

    const day = await ok(
      `/api/reservations?from=${DATE}T00:00:00.000Z&to=${DATE}T23:59:59.999Z`,
      { as: ravi },
    );
    expect(day.length).toBeGreaterThan(0);
    await ok(`/api/timeline?entityType=reservation&entityId=${id}`, { as: ravi });
  });

  // -- what an owner configures --------------------------------------------

  it('an owner configures the club and reads its numbers', async () => {
    await ok('/api/venue', {
      as: astrid, method: 'POST',
      body: { name: 'RallyPoint Solna', timezone: 'Europe/Stockholm', holdMinutes: 10 },
    });
    await ok('/api/hours', {
      as: astrid, method: 'POST', body: { weekday: 3, opensAt: '07:00', closesAt: '23:00' },
    });
    const newCourt = await ok('/api/courts', {
      as: astrid, method: 'POST', body: { name: 'Bana 9', durations: '60,90' },
    });
    await ok('/api/court-hours', {
      as: astrid, method: 'POST',
      body: { resourceId: newCourt.id, weekday: 3, opensAt: '09:00', closesAt: '21:00' },
    });
    await ok(`/api/courts/${newCourt.id}/active`, {
      as: astrid, method: 'POST', body: { active: false },
    });
    await ok('/api/closures', {
      as: astrid, method: 'POST', body: { onDate: soon(40), reason: 'Klubbmästerskap' },
    });
    await ok('/api/price-rules', {
      as: astrid, method: 'POST', body: { label: 'Morgon', fromTime: '06:00', toTime: '09:00', amount: '200' },
    });
    await ok('/api/packs', {
      as: astrid, method: 'POST',
      body: { key: 'klipp-3', title: '3 för 2', priceOre: 68000, creditOre: 102000 },
    });
    await ok('/api/plans', {
      as: astrid, method: 'POST',
      body: { key: 'guld', title: 'Guld', monthlyOre: 199900, monthlyCreditOre: 250000 },
    });
    await ok('/api/members', {
      as: astrid, method: 'POST',
      body: { partyRef: '01JTESTAAAAAAAAAAAAAAAAAAB', name: 'Ny Spelare' },
    });

    const occ = await ok(`/api/occupancy?from=${DATE}&to=${DATE}`, { as: astrid });
    expect(occ.openHours).toBeGreaterThan(0);
    const roles = await ok('/api/roles', { as: astrid });
    expect(roles.map((r: any) => r.key).sort()).toEqual(['club-admin', 'coach', 'receptionist']);

    await ok('/api/maintenance', {
      as: astrid, method: 'POST',
      body: { resourceId: court, date: DATE, time: '12:00', duration: 60, reason: 'Omslipning' },
    });
  });

  // -- the denials, at the surface a browser actually hits -------------------

  it('every boundary answers the same way through HTTP as it does in-scope', async () => {
    // Coach: reads the calendar, books nothing.
    expect((await call('/api/reservations', { as: nils })).status).toBe(200);
    expect(
      (await call('/api/bookings', {
        as: nils, method: 'POST',
        body: { resourceId: court, memberId: elinM, date: DATE, time: '13:00', duration: 60 },
      })).status,
    ).toBe(403);

    // Receptionist: books all day, re-cuts nothing.
    expect((await call('/api/hours', { as: ravi, method: 'POST', body: { weekday: 2 } })).status).toBe(403);
    expect((await call('/api/roles', { as: ravi })).status).toBe(403);

    // Player: no roster, no book, no roles, no other wallet.
    expect((await call('/api/roles', { as: elin })).status).toBe(403);
    expect((await call(`/api/wallet?memberId=${johanM}`, { as: elin })).status).toBe(403);
    expect((await call(`/api/occupancy?from=${DATE}&to=${DATE}`, { as: elin })).status).toBe(403);

    // No principal at all.
    expect((await call('/api/venue')).status).toBe(403);

    // Another company's admin, pointed at this club's scope. Note this is 403
    // and NOT the `unknown scope` 404 the in-scope test sees: there, the
    // attacker names the (tenant, scope) pair himself and gets it wrong. Here
    // the SERVER supplies the pair from its venue table, so he cannot mis-pair
    // it — he reaches a real scope and is refused by the permission model
    // instead. A stronger answer, from one layer further in.
    expect((await call('/api/members', { as: rutger, venue: 'solna' })).status).toBe(403);
  });

  // -- the guard that makes "shipped but unreachable" a red build -----------

  it('every registered route is exercised by these flows', () => {
    const registered = new Set(
      app.routes
        .filter((r) => r.path.startsWith('/api'))
        .map((r) => `${r.method} ${r.path.replace(/:[a-zA-Z]+/g, ':id')}`),
    );
    const untested = [...registered].filter((r) => !seen.has(r)).sort();
    expect({ untested }).toEqual({ untested: [] });
  });
});
