import { describe, it, expect } from 'vitest';
import { platformActorId, connectionId, scopeId, tenantId } from '@substrat-run/contracts';
import { runPlatformSweep, startPlatformSweeper } from '../src/platform-sweep.js';
import type { ConnectorSweeper } from '../src/platform-sweep.js';
import type { FetchLike, ScopeHost } from '../src/scope-host.js';

/**
 * The orchestration, with fakes — that the pass enumerates, drains, dispatches by
 * provider, isolates failures, and bounds concurrency. The REAL chain (a sweep
 * that actually completes a signature) is proven end-to-end against the SQLite
 * adapter in the connector package; here we hold the driver itself to its
 * contract without a provider or a database in the way.
 */

const ACTOR = platformActorId.parse('01JZ00000000000000000000SV');
const FETCH = (() => Promise.reject(new Error('fetch is not used by these fakes'))) as unknown as FetchLike;

// ULID-shaped ids from a counter — digits are all valid Crockford base32, so no
// risk of the I/L/O/U the alphabet excludes. Unique and deterministic.
let idCounter = 0;
const genId = () => '01J' + String(++idCounter).padStart(23, '0');
const sid = () => scopeId.parse(genId());
const cid = () => connectionId.parse(genId());
const T = tenantId.parse(genId());

/** A ScopeHost with only the three methods the driver touches; the rest throws if reached. */
function fakeHost(opts: {
  scopes?: { id: ReturnType<typeof sid>; tenantId: typeof T }[];
  connections?: { id: ReturnType<typeof cid>; provider: string; revokedAt: string | null }[];
  drainDue?: ScopeHost['drainDue'];
}): ScopeHost {
  const admin = {
    listScopes: async () => (opts.scopes ?? []).map((s) => ({ ...s, status: 'active' })),
    listConnections: async () => opts.connections ?? [],
  };
  return {
    admin,
    drainDue:
      opts.drainDue ??
      (async () => ({ attempted: 0, delivered: 0, retrying: 0, deadLettered: 0 })),
  } as unknown as ScopeHost;
}

describe('runPlatformSweep', () => {
  it('drains active scopes and sweeps live connections, summing drain totals', async () => {
    const scopes = [{ id: sid(), tenantId: T }, { id: sid(), tenantId: T }];
    const conns = [
      { id: cid(), provider: 'scrive', revokedAt: null },
      { id: cid(), provider: 'scrive', revokedAt: null },
    ];
    const drained: string[] = [];
    const swept: string[] = [];
    const host = fakeHost({
      scopes,
      connections: conns,
      drainDue: async (_t, s) => {
        drained.push(s);
        return { attempted: 2, delivered: 1, retrying: 1, deadLettered: 0 };
      },
    });
    const sweeper: ConnectorSweeper = async (_h, id) => {
      swept.push(id);
    };

    const report = await runPlatformSweep(host, { actor: ACTOR, fetch: FETCH, sweepers: { scrive: sweeper } });

    expect(drained.sort()).toEqual(scopes.map((s) => s.id).sort());
    expect(swept.sort()).toEqual(conns.map((c) => c.id).sort());
    expect(report.scopesDrained).toBe(2);
    expect(report.connectionsSwept).toBe(2);
    expect(report.drainTotals).toEqual({ attempted: 4, delivered: 2, retrying: 2, deadLettered: 0 });
    expect(report.errors).toEqual([]);
  });

  it('skips revoked connections and providers with no sweeper', async () => {
    const live = cid();
    const conns = [
      { id: live, provider: 'scrive', revokedAt: null },
      { id: cid(), provider: 'scrive', revokedAt: '2026-01-01T00:00:00.000Z' }, // revoked
      { id: cid(), provider: 'fortnox', revokedAt: null }, // no sweeper registered
    ];
    const swept: string[] = [];
    const host = fakeHost({ connections: conns });
    const report = await runPlatformSweep(host, {
      actor: ACTOR,
      fetch: FETCH,
      sweepers: { scrive: async (_h, id) => void swept.push(id) },
    });
    expect(swept).toEqual([live]);
    expect(report.connectionsSwept).toBe(1);
    expect(report.connectionsSkipped).toBe(2);
  });

  it('records a failure on one unit and steps over it — the batch is not sunk', async () => {
    const bad = cid();
    const good = cid();
    const host = fakeHost({
      scopes: [{ id: sid(), tenantId: T }],
      connections: [
        { id: bad, provider: 'scrive', revokedAt: null },
        { id: good, provider: 'scrive', revokedAt: null },
      ],
      drainDue: async () => {
        throw new Error('scope DO unreachable');
      },
    });
    const swept: string[] = [];
    const sweeper: ConnectorSweeper = async (_h, id) => {
      if (id === bad) throw new Error('provider 500');
      swept.push(id);
    };
    const report = await runPlatformSweep(host, { actor: ACTOR, fetch: FETCH, sweepers: { scrive: sweeper } });

    expect(swept).toEqual([good]); // the good one still ran
    expect(report.connectionsSwept).toBe(1);
    expect(report.errors).toContainEqual({ kind: 'sweep', id: bad, error: 'provider 500' });
    expect(report.errors.some((e) => e.kind === 'drain' && e.error === 'scope DO unreachable')).toBe(true);
  });

  it('bounds concurrency', async () => {
    const conns = Array.from({ length: 20 }, () => ({ id: cid(), provider: 'scrive', revokedAt: null }));
    let inFlight = 0;
    let peak = 0;
    const sweeper: ConnectorSweeper = async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      await Promise.resolve();
      inFlight -= 1;
    };
    const report = await runPlatformSweep(fakeHost({ connections: conns }), {
      actor: ACTOR,
      fetch: FETCH,
      sweepers: { scrive: sweeper },
      concurrency: 4,
      drainRetries: false,
    });
    expect(report.connectionsSwept).toBe(20);
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1); // it did run in parallel, not serially
  });

  it('drainRetries: false sweeps only connectors', async () => {
    let drainCalled = false;
    const host = fakeHost({
      scopes: [{ id: sid(), tenantId: T }],
      connections: [{ id: cid(), provider: 'scrive', revokedAt: null }],
      drainDue: async () => {
        drainCalled = true;
        return { attempted: 0, delivered: 0, retrying: 0, deadLettered: 0 };
      },
    });
    const report = await runPlatformSweep(host, {
      actor: ACTOR,
      fetch: FETCH,
      sweepers: { scrive: async () => {} },
      drainRetries: false,
    });
    expect(drainCalled).toBe(false);
    expect(report.scopesDrained).toBe(0);
    expect(report.connectionsSwept).toBe(1);
  });
});

describe('startPlatformSweeper', () => {
  /** A hand-driven clock: startPlatformSweeper reschedules via these, so a test owns the cadence. */
  function fakeClock() {
    let seq = 0;
    const pending = new Map<number, () => void>();
    return {
      setTimer: (cb: () => void) => {
        const id = ++seq;
        pending.set(id, cb);
        return id;
      },
      clearTimer: (h: unknown) => pending.delete(h as number),
      /** Fire the one scheduled callback and let its async body fully settle. */
      async fire() {
        const [id, cb] = [...pending.entries()][0]!;
        pending.delete(id);
        cb();
        // A real macrotask boundary drains the pass's entire microtask chain
        // (all awaits resolve via microtasks) before returning.
        await new Promise((r) => setTimeout(r, 0));
      },
      count: () => pending.size,
    };
  }

  it('runs a pass per tick, reschedules only after it settles, and stops cleanly', async () => {
    const clock = fakeClock();
    const host = fakeHost({ connections: [{ id: cid(), provider: 'scrive', revokedAt: null }] });
    const passes: number[] = [];
    const handle = startPlatformSweeper(host, {
      actor: ACTOR,
      fetch: FETCH,
      sweepers: { scrive: async () => {} },
      intervalMs: 1000,
      onPass: (o) => passes.push('error' in o ? -1 : o.connectionsSwept),
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });

    // One timer is armed, nothing has run yet.
    expect(clock.count()).toBe(1);
    expect(passes).toEqual([]);

    await clock.fire(); // first pass
    expect(passes).toEqual([1]);
    expect(clock.count()).toBe(1); // rescheduled exactly one, no overlap

    await clock.fire(); // second pass
    expect(passes).toEqual([1, 1]);

    handle.stop();
    expect(clock.count()).toBe(0); // pending timer cancelled
  });

  it('a throwing pass is reported, not fatal, and the loop keeps going', async () => {
    const clock = fakeClock();
    // Make the enumeration itself throw — that is NOT caught inside a pass, so it
    // rejects `runPlatformSweep` and exercises the sweeper's own catch.
    const host = fakeHost({});
    (host.admin as unknown as { listScopes: () => Promise<never> }).listScopes = () => {
      throw new Error('directory unreachable');
    };
    const outcomes: (string | number)[] = [];
    startPlatformSweeper(host, {
      actor: ACTOR,
      fetch: FETCH,
      sweepers: {},
      intervalMs: 1000,
      onPass: (o) => outcomes.push('error' in o ? o.error : o.connectionsSwept),
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    await clock.fire();
    expect(outcomes).toEqual(['directory unreachable']); // reported, not thrown
    expect(clock.count()).toBe(1); // rescheduled despite the failure
  });
});
