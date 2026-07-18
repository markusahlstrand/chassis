import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { CloudflareScopeHost } from '@substrat-run/adapter-cloudflare';
import { DEV_ACTOR_HEADER } from '@substrat-run/control-plane-api';
import { ulid } from '@substrat-run/kernel';

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
