import { Hono } from 'hono';
import type { Context } from 'hono';
import { principalId, type PrincipalId } from '@substrat-run/contracts';
import { PermissionDenied, type ScopeStub } from '@substrat-run/kernel';
import type { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import type { RallyWorld } from './seed.js';

/**
 * The RallyPoint demo API, as a factory rather than a module with side effects.
 *
 * Split out of server.ts so tests can drive the REAL routes through
 * `app.request(...)` without a port or a listening socket. That matters: every
 * route here is a thin wrapper, and the bugs it has actually shipped were
 * wiring bugs — a handler that existed with no route in front of it. A test
 * that calls operations directly cannot see those; one that goes through this
 * app can.
 */
export function createRallyApp(host: SqliteScopeHost, world: RallyWorld): Hono {
  const CAST: Record<string, { name: string; role: string; principal: PrincipalId }> = {
    astrid: { name: 'Astrid (klubbchef)', role: 'club-admin', principal: world.astrid },
    ravi: { name: 'Ravi (reception, Solna)', role: 'receptionist', principal: world.ravi },
    nils: { name: 'Nils (tränare)', role: 'coach', principal: world.nils },
    elin: { name: 'Elin (spelare)', role: 'player', principal: world.elin },
    johan: { name: 'Johan (spelare)', role: 'player', principal: world.johan },
    rutger: { name: 'Rutger (annan klubb!)', role: 'attacker', principal: world.rutger },
  };

  /**
   * The venues this demo knows about. Two belong to RallyPoint AB and one to a
   * different company — picking the wrong one is not a UI error, it is the tenancy
   * boundary answering. Astrid's `club-admin` role is tenant-level, so she reaches
   * Solna and Nacka; Ravi's is scoped to Solna; nobody at RallyPoint reaches
   * Göteborg at all.
   */
  const VENUES: Record<string, { label: string; tenantId: typeof world.t1; scopeId: typeof world.s1 }> =
    {
      solna: { label: 'RallyPoint Solna', tenantId: world.t1, scopeId: world.s1 },
      nacka: { label: 'RallyPoint Nacka', tenantId: world.t1, scopeId: world.s1b },
      goteborg: { label: 'Padelcenter Göteborg', tenantId: world.t2, scopeId: world.s2 },
    };

  const app = new Hono();

  function principalOf(c: Context): PrincipalId {
    const raw = c.req.header('x-principal');
    if (!raw) throw new PermissionDenied('missing x-principal header');
    return principalId.parse(raw);
  }

  async function stub(c: Context): Promise<ScopeStub> {
    const key = c.req.header('x-venue') ?? 'solna';
    const venue = VENUES[key];
    if (!venue) throw new PermissionDenied(`unknown venue: ${key}`);
    // getScope cross-checks (tenantId, scopeId) and fails closed — a principal
    // claiming another company's scope gets `unknown scope`, not a 403.
    return host.getScope(principalOf(c), venue.tenantId, venue.scopeId);
  }

  const body = async (c: Context): Promise<Record<string, unknown>> =>
    c.req.json<Record<string, unknown>>().catch(() => ({}));

  app.onError((err, c) => {
    if (err instanceof PermissionDenied) return c.json({ error: err.message }, 403);
    // The engine's typed rejection — the console renders it as "just taken" and
    // keeps everything the receptionist typed.
    if (err.name === 'SlotUnavailable') return c.json({ error: err.message, code: 'SLOT_UNAVAILABLE' }, 409);
    if (/not found|unknown scope/.test(err.message)) return c.json({ error: err.message }, 404);
    return c.json({ error: err.message }, 400);
  });

  app.get('/api/cast', (c) =>
    c.json({
      cast: CAST,
      venues: Object.entries(VENUES).map(([key, v]) => ({ key, label: v.label })),
      // Member ids are per venue: the same human has a separate member record in
      // every club they belong to, tied together only by the global player ref.
      members: {
        solna: { elin: world.elinId, johan: world.johanId },
        nacka: { elin: world.elinNackaId, johan: world.johanNackaId },
        goteborg: { elin: '', johan: '' },
      },
    }),
  );

  /**
   * Which venues THIS caller can actually work in.
   *
   * Handover 2a: "reception roles are pinned to one venue and see no switcher."
   * Reachability is not a UI preference — it is the permission model answering, so
   * it is probed rather than assumed: `getScope` accepts any valid (tenant, scope)
   * pair, and the role check is what actually decides. A principal with one venue
   * gets no switcher; an owner with several gets the overview.
   */
  app.get('/api/my-venues', async (c) => {
    const principal = principalOf(c);
    const reachable: { key: string; label: string }[] = [];
    for (const [key, v] of Object.entries(VENUES)) {
      try {
        const s = await host.getScope(principal, v.tenantId, v.scopeId);
        await s.invoke('rally/get-venue'); // requires rally:browse in that scope
        reachable.push({ key, label: v.label });
      } catch {
        // Not reachable for this principal — deliberately silent, not an error.
      }
    }
    return c.json(reachable);
  });

  // -- the club's shape -------------------------------------------------------
  app.get('/api/venue', async (c) => c.json(await (await stub(c)).invoke('rally/get-venue')));
  app.post('/api/venue', async (c) => c.json(await (await stub(c)).invoke('rally/set-venue', await body(c))));
  app.post('/api/hours', async (c) => c.json(await (await stub(c)).invoke('rally/set-hours', await body(c))));
  app.post('/api/court-hours', async (c) =>
    c.json(await (await stub(c)).invoke('rally/set-court-hours', await body(c))),
  );
  app.post('/api/closures', async (c) =>
    c.json(await (await stub(c)).invoke('rally/add-closure', await body(c))),
  );

  // -- courts -----------------------------------------------------------------
  // Two doors on purpose: staff read the engine's resource list (booking:read),
  // players browse free/busy only (rally:browse).
  app.get('/api/browse/courts', async (c) => c.json(await (await stub(c)).invoke('rally/courts')));
  app.get('/api/courts', async (c) => c.json(await (await stub(c)).invoke('booking/list-resources')));
  app.post('/api/courts', async (c) => {
    const s = await stub(c);
    const input = await body(c);
    const court = await s.invoke<{ id: string }>('booking/create-resource', {
      kind: 'court',
      name: input.name,
    });
    await s.invoke('rally/register-court', {
      resourceId: court.id,
      ...(input.durations !== undefined ? { durations: input.durations } : {}),
    });
    return c.json(court);
  });
  app.post('/api/courts/:id/active', async (c) =>
    c.json(
      await (await stub(c)).invoke('booking/set-resource-active', {
        resourceId: c.req.param('id'),
        ...(await body(c)),
      }),
    ),
  );

  // -- pricing ----------------------------------------------------------------
  app.post('/api/price-rules', async (c) =>
    c.json(await (await stub(c)).invoke('rally/upsert-price-rule', await body(c))),
  );

  // -- members ----------------------------------------------------------------
  app.get('/api/members', async (c) => c.json(await (await stub(c)).invoke('rally/list-members')));
  app.post('/api/members', async (c) =>
    c.json(await (await stub(c)).invoke('rally/create-member', await body(c))),
  );

  // -- the calendar & booking -------------------------------------------------
  app.get('/api/availability', async (c) =>
    c.json(
      await (await stub(c)).invoke('rally/availability', {
        resourceId: c.req.query('resourceId'),
        date: c.req.query('date'),
      }),
    ),
  );
  app.get('/api/reservations', async (c) =>
    c.json(
      await (await stub(c)).invoke('booking/list', {
        ...(c.req.query('from') ? { from: c.req.query('from') } : {}),
        ...(c.req.query('to') ? { to: c.req.query('to') } : {}),
      }),
    ),
  );
  app.get('/api/reservations/:id', async (c) =>
    c.json(await (await stub(c)).invoke('booking/get', { reservationId: c.req.param('id') })),
  );
  app.post('/api/bookings', async (c) =>
    c.json(await (await stub(c)).invoke('rally/book-court', await body(c))),
  );
  app.post('/api/bookings/:id/confirm', async (c) =>
    c.json(
      await (await stub(c)).invoke('rally/confirm-booking', {
        reservationId: c.req.param('id'),
        ...(await body(c)), // { payWith?: 'wallet' | 'card' }
      }),
    ),
  );
  app.post('/api/bookings/:id/cancel', async (c) =>
    c.json(
      await (await stub(c)).invoke('booking/cancel', {
        reservationId: c.req.param('id'),
        ...(await body(c)),
      }),
    ),
  );
  app.post('/api/bookings/:id/move', async (c) =>
    c.json(
      await (await stub(c)).invoke('booking/move', {
        reservationId: c.req.param('id'),
        ...(await body(c)),
      }),
    ),
  );
  app.post('/api/bookings/:id/no-show', async (c) =>
    c.json(await (await stub(c)).invoke('booking/no-show', { reservationId: c.req.param('id') })),
  );
  app.post('/api/maintenance', async (c) =>
    c.json(await (await stub(c)).invoke('rally/block-maintenance', await body(c))),
  );

  // -- open matches -----------------------------------------------------------
  app.get('/api/matches', async (c) => c.json(await (await stub(c)).invoke('rally/open-matches')));
  app.get('/api/matches/:id', async (c) =>
    c.json(await (await stub(c)).invoke('rally/match', { reservationId: c.req.param('id') })),
  );
  app.post('/api/bookings/:id/players', async (c) =>
    c.json(
      await (await stub(c)).invoke('rally/add-player', {
        reservationId: c.req.param('id'),
        ...(await body(c)),
      }),
    ),
  );
  app.post('/api/matches', async (c) =>
    c.json(await (await stub(c)).invoke('rally/create-open-match', await body(c))),
  );
  app.post('/api/matches/:id/join', async (c) =>
    c.json(
      await (await stub(c)).invoke('rally/join-match', {
        reservationId: c.req.param('id'),
        ...(await body(c)),
      }),
    ),
  );

  // -- wallet, credit packs and subscriptions ---------------------------------
  app.get('/api/wallet', async (c) =>
    c.json(await (await stub(c)).invoke('rally/wallet', { memberId: c.req.query('memberId') })),
  );
  app.post('/api/wallet/buy', async (c) =>
    c.json(await (await stub(c)).invoke('rally/buy-credits', await body(c))),
  );
  app.post('/api/packs', async (c) =>
    c.json(await (await stub(c)).invoke('rally/upsert-pack', await body(c))),
  );
  app.post('/api/plans', async (c) =>
    c.json(await (await stub(c)).invoke('rally/upsert-plan', await body(c))),
  );
  app.post('/api/subscriptions', async (c) =>
    c.json(await (await stub(c)).invoke('rally/subscribe', await body(c))),
  );
  app.post('/api/subscriptions/:id/cancel', async (c) =>
    c.json(
      await (await stub(c)).invoke('rally/cancel-subscription', {
        subscriptionId: c.req.param('id'),
      }),
    ),
  );
  /**
   * The step a billing Workflow would invoke. It is an operation rather than a
   * timer because the schedule belongs outside the scope — durable, long-waiting,
   * retryable per step (docs/design/booking-social.md §7) — while the credit and
   * the cursor advance belong inside one transaction.
   */
  app.post('/api/billing/run', async (c) =>
    c.json(await (await stub(c)).invoke('rally/run-billing', await body(c))),
  );

  // -- reports ----------------------------------------------------------------
  app.get('/api/occupancy', async (c) =>
    c.json(
      await (await stub(c)).invoke('rally/occupancy', {
        from: c.req.query('from'),
        to: c.req.query('to'),
      }),
    ),
  );

  /**
   * Role definitions come from the CONTROL PLANE, not from a scope — roles live in
   * the directory beside the tenant registry, so no module code can read them
   * (kernel scope-host: `listRoles`). The server is harness code and may, but it
   * gates on the caller proving club-admin inside the scope first, so this is not
   * a back door around the permission model.
   */
  app.get('/api/roles', async (c) => {
    const s = await stub(c);
    await s.invoke('rally/can-admin'); // throws PermissionDenied for anyone else
    const key = c.req.header('x-venue') ?? 'solna';
    const venue = VENUES[key]!;
    const roles = await host.admin.listRoles({ tenantId: venue.tenantId });
    return c.json(roles);
  });

  // -- portal -----------------------------------------------------------------
  app.get('/api/portal/bookings', async (c) =>
    c.json(await (await stub(c)).invoke('rally/portal-bookings')),
  );
  app.get('/api/timeline', async (c) =>
    c.json(
      await (await stub(c)).invoke('rally/timeline', {
        entityType: c.req.query('entityType'),
        entityId: c.req.query('entityId'),
      }),
    ),
  );

  return app;
}
