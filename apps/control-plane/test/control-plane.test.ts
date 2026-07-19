import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { CloudflareScopeHost } from '@substrat-run/adapter-cloudflare';
import { DEV_ACTOR_HEADER } from '@substrat-run/control-plane-api';
import { ulid } from '@substrat-run/kernel';
import { d1StaffRoster, listStaff } from '../src/staff-roster.js';

/**
 * Slice 1's definition of done, as an automated workerd test (first-flow.md §4):
 * the control-plane worker stands up, `/tenants` starts empty, a POST persists
 * into the durable ControlPlaneDO, and an unauthenticated request fails closed.
 *
 * Persistence is asserted two ways. Within the worker: a POST is read back by a
 * later GET. Across the coordinator: a *fresh* `CloudflareScopeHost` — a new
 * stateless coordinator, exactly what a real second request or the console is —
 * reads the same tenant straight from the DO. That second assertion is the real
 * property: the directory lives in durable DO storage, not in any isolate's
 * memory, so any coordinator that reaches this DO namespace sees it.
 */

// A valid ULID platform actor; the dev stub (enabled via ALLOW_DEV_ACTOR in
// vitest.config.ts) trusts this header verbatim.
const ACTOR = ulid();
const authed = {
  [DEV_ACTOR_HEADER]: ACTOR,
  'content-type': 'application/json',
};

describe('shared control-plane worker', () => {
  it('serves an empty tenant registry before anything is created', async () => {
    const res = await SELF.fetch('https://cp.test/api/tenants', { headers: authed });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('persists a created tenant through the durable DO', async () => {
    const id = ulid();
    const create = await SELF.fetch('https://cp.test/api/tenants', {
      method: 'POST',
      headers: authed,
      body: JSON.stringify({ id, slug: 'acme', name: 'Acme AB' }),
    });
    expect(create.status).toBe(201);
    expect(await create.json()).toMatchObject({ id, slug: 'acme', name: 'Acme AB', status: 'active' });

    // Read back through the worker.
    const list = (await (await SELF.fetch('https://cp.test/api/tenants', { headers: authed })).json()) as {
      id: string;
    }[];
    expect(list.map((t) => t.id)).toContain(id);

    // Read back through a brand-new coordinator against the same DO namespace —
    // proof the row is in durable storage, reachable by any stateless host.
    const fresh = new CloudflareScopeHost({ scope: env.SCOPE, controlPlane: env.CONTROL_PLANE });
    const tenants = await fresh.admin.listTenants();
    expect(tenants.map((t) => t.id)).toContain(id);
    await fresh.close();
  });

  it('fails closed without a platform actor', async () => {
    const res = await SELF.fetch('https://cp.test/api/tenants');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthenticated' });
  });
});

/**
 * The staff roster (#42). Before this, every rostered email mapped to ONE
 * hardcoded actor, so the admin log could not distinguish which operator
 * suspended a tenant — the surface could act without a durable record of *who*,
 * which §4.4 says is worse than no surface at all.
 */
describe('staff roster', () => {
  const resolver = d1StaffRoster(env.AUTH_DB);
  const ACTOR_A = '01JZ0000000000000000000AAA';
  const ACTOR_B = '01JZ0000000000000000000BBB';

  beforeAll(async () => {
    await env.AUTH_DB.exec(
      'CREATE TABLE IF NOT EXISTS staff_actor (email TEXT PRIMARY KEY, actor TEXT NOT NULL, name TEXT, added_at TEXT NOT NULL, revoked_at TEXT)',
    );
    const add = (email: string, actor: string, revokedAt: string | null) =>
      env.AUTH_DB.prepare(
        'INSERT OR REPLACE INTO staff_actor (email, actor, name, added_at, revoked_at) VALUES (?, ?, NULL, ?, ?)',
      )
        .bind(email, actor, new Date().toISOString(), revokedAt)
        .run();
    await add('ada@substrat.run', ACTOR_A, null);
    await add('grace@substrat.run', ACTOR_B, null);
    await add('gone@substrat.run', '01JZ0000000000000000000CCC', new Date().toISOString());
    await add('broken@substrat.run', 'not-a-ulid', null);
  });

  it('resolves each operator to their OWN actor', async () => {
    // The whole point: two operators must be distinguishable in the audit trail.
    const a = await resolver({ email: 'ada@substrat.run' });
    const b = await resolver({ email: 'grace@substrat.run' });
    expect(a).toBe(ACTOR_A);
    expect(b).toBe(ACTOR_B);
    expect(a).not.toBe(b);
  });

  it('is case-insensitive on email', async () => {
    expect(await resolver({ email: 'Ada@Substrat.RUN' })).toBe(ACTOR_A);
  });

  it('refuses someone not on the roster', async () => {
    expect(await resolver({ email: 'stranger@example.com' })).toBeNull();
  });

  it('refuses a revoked operator — the row stays as evidence', async () => {
    expect(await resolver({ email: 'gone@substrat.run' })).toBeNull();
    // Tombstone, not delete (K-21): revoking access must not erase the record
    // that it was once granted.
    const row = await env.AUTH_DB.prepare(
      'SELECT revoked_at FROM staff_actor WHERE email = ?',
    )
      .bind('gone@substrat.run')
      .first<{ revoked_at: string | null }>();
    expect(row?.revoked_at).toEqual(expect.any(String));
  });

  it('fails closed on a malformed stored actor rather than coercing it', async () => {
    // An actor the audit log cannot name is exactly what §4.4 refuses to write.
    expect(await resolver({ email: 'broken@substrat.run' })).toBeNull();
  });

  it('lists the roster, revoked included, for "who has platform access"', async () => {
    const roster = await listStaff(env.AUTH_DB);
    const emails = roster.map((r) => r.email);
    expect(emails).toContain('ada@substrat.run');
    expect(emails).toContain('gone@substrat.run');
    // Live first, revoked last — the roster reads as a roster, not a history.
    expect(roster.findIndex((r) => r.revokedAt !== null)).toBeGreaterThan(
      roster.findIndex((r) => r.revokedAt === null),
    );
    // A row whose stored actor is unusable is still LISTED, with a null actor —
    // one bad row must not blank the roster, and hiding it would hide the problem.
    const broken = roster.find((r) => r.email === 'broken@substrat.run');
    expect(broken).toBeDefined();
    expect(broken?.actor).toBeNull();
  });
});
