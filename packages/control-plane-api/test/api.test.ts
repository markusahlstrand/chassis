import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { ulid } from '@substrat-run/kernel';
import { permissionKey, platformActorId, scopeId, tenantId } from '@substrat-run/contracts';
import {
  createControlPlaneApi,
  DEV_ACTOR_HEADER,
  UNSAFE_devPlatformActorAuth,
  VerticalClient,
} from '../src/index.js';

/**
 * The transport contract (control-plane.md §4.5). These drive the HTTP surface
 * end-to-end against a real adapter — the routes, the Zod boundary, the error
 * mapping, and the one property the whole surface exists to preserve: the actor
 * is stamped from the authenticated request and cannot be supplied by the caller.
 */
describe('control-plane API', () => {
  let dir: string;
  let host: SqliteScopeHost;
  let app: ReturnType<typeof createControlPlaneApi>;

  const staff = platformActorId.parse(ulid());
  const t1 = tenantId.parse(ulid());
  const t2 = tenantId.parse(ulid());
  const s1 = scopeId.parse(ulid());

  const auth = { [DEV_ACTOR_HEADER]: staff, 'content-type': 'application/json' };
  const req = (path: string, init?: RequestInit) =>
    app.request(path, { headers: auth, ...init });
  const json = (path: string, method: string, body?: unknown) =>
    app.request(path, { method, headers: auth, body: body === undefined ? undefined : JSON.stringify(body) });

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-api-'));
    host = new SqliteScopeHost({ dir });
    app = createControlPlaneApi({ host, authenticate: UNSAFE_devPlatformActorAuth() });
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // -- the actor seam (§4.4/§6) ---------------------------------------------

  it('refuses every request without an actor, fail closed', async () => {
    const bare = await app.request('/tenants');
    expect(bare.status).toBe(401);
    // A write is refused before it reaches the host, not after.
    const write = await app.request('/tenants', {
      method: 'POST',
      body: JSON.stringify({ id: tenantId.parse(ulid()), slug: 'ghost', name: 'Ghost' }),
    });
    expect(write.status).toBe(401);
    expect(await host.admin.listTenants(staff)).toHaveLength(0);
  });

  it('refuses a malformed actor rather than writing it to the log', async () => {
    const res = await app.request('/tenants', { headers: { [DEV_ACTOR_HEADER]: 'not-a-ulid' } });
    expect(res.status).toBe(401);
  });

  it('stamps the audit actor from the request — a body actor cannot forge it', async () => {
    const impostor = platformActorId.parse(ulid());
    const res = await json('/tenants', 'POST', {
      id: t1,
      slug: 'acme-co',
      name: 'Acme Co',
      // There is no route that accepts an actor; this rides along to prove it is
      // dropped at the Zod boundary rather than reaching the audit row (§4.4:
      // stamped platform-side, "never supplied by the caller").
      actor: impostor,
    });
    expect(res.status).toBe(201);

    const rows = (await host.admin.auditLog(staff, { tenantId: t1 })).filter(
      (r) => r.action === 'createTenant',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor).toBe(staff);
    expect(rows[0]!.actor).not.toBe(impostor);
  });

  // -- tenant registry (§4.1) -----------------------------------------------

  it('creates a tenant, idempotently, and reads it back', async () => {
    const again = await json('/tenants', 'POST', { id: t1, slug: 'acme-co', name: 'Acme Co' });
    expect(again.status).toBe(201); // idempotent — a no-op, not an error

    const got = await req(`/tenants/${t1}`);
    expect(got.status).toBe(200);
    expect(await got.json()).toMatchObject({ id: t1, slug: 'acme-co', status: 'active' });

    const list = await (await req('/tenants')).json();
    expect(list).toHaveLength(1);
  });

  it('maps a tenant slug collision to 409', async () => {
    const res = await json('/tenants', 'POST', {
      id: tenantId.parse(ulid()),
      slug: 'acme-co',
      name: 'Impostor',
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/already taken/);
  });

  it('maps an unknown tenant to 404', async () => {
    expect((await req(`/tenants/${tenantId.parse(ulid())}`)).status).toBe(404);
  });

  it('rejects a malformed body at the Zod boundary with 400', async () => {
    const res = await json('/tenants', 'POST', { id: 'nope', slug: 'x', name: '' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid request');
  });

  it('transitions tenant status', async () => {
    const res = await json(`/tenants/${t1}/status`, 'PATCH', { status: 'suspended' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'suspended' });
    await json(`/tenants/${t1}/status`, 'PATCH', { status: 'active' });
  });

  // -- entitlements (§4.3) --------------------------------------------------

  it('grants, lists and revokes entitlements', async () => {
    expect(await (await req(`/tenants/${t1}/entitlements`)).json()).toEqual([]);

    const granted = await json(`/tenants/${t1}/entitlements/workorder`, 'PUT');
    expect(await granted.json()).toEqual(['workorder']);

    const revoked = await json(`/tenants/${t1}/entitlements/workorder`, 'DELETE');
    expect(await revoked.json()).toEqual([]);
  });

  // -- the scope directory (§3.2/§4.2) --------------------------------------

  it('provisions a scope and returns the directory record', async () => {
    const res = await json('/scopes', 'POST', {
      tenantId: t1,
      scopeId: s1,
      slug: 'brf-vasastan',
      kind: 'brf',
      name: 'Brf Vasastan',
      vertical: 'housing',
      jurisdiction: 'global',
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      id: s1,
      tenantId: t1,
      slug: 'brf-vasastan',
      kind: 'brf',
      vertical: 'housing',
      jurisdiction: 'global',
      // Not `active`: the directory row exists before the vertical has built the
      // scope, and `activateScope` is the confirmation that it has (K-31).
      status: 'provisioning',
    });

    expect((await json(`/tenants/${t1}/scopes/${s1}/activate`, 'POST')).status).toBe(200);
    const activated = await (await req(`/tenants/${t1}/scopes/${s1}`)).json();
    expect(activated.status).toBe('active');
  });

  it('gates eu/us jurisdiction at the boundary until enforcement exists (K-32)', async () => {
    // `eu` is a storable value but not a provisionable one: accepting it would
    // record a residency claim with no mechanism. Refused with 400, not written.
    const res = await json('/scopes', 'POST', {
      tenantId: t1,
      scopeId: s1,
      slug: 'brf-eu',
      name: 'Brf EU',
      jurisdiction: 'eu',
    });
    expect(res.status).toBe(400);
  });

  it('refuses to provision under an unknown tenant with 409', async () => {
    const res = await json('/scopes', 'POST', {
      tenantId: tenantId.parse(ulid()),
      scopeId: scopeId.parse(ulid()),
    });
    expect(res.status).toBe(409);
  });

  it('lists scopes and filters by tenant, status and vertical', async () => {
    await json('/tenants', 'POST', { id: t2, slug: 'other-co', name: 'Other Co' });
    const s2 = scopeId.parse(ulid());
    await json('/scopes', 'POST', { tenantId: t2, scopeId: s2, slug: 'other-scope' });
    await json(`/tenants/${t2}/scopes/${s2}/activate`, 'POST');

    const all = await (await req('/scopes')).json();
    expect(all).toHaveLength(2);

    const mine = await (await req(`/scopes?tenantId=${t1}`)).json();
    expect(mine).toHaveLength(1);

    const housing = await (await req('/scopes?vertical=housing')).json();
    expect(housing.map((s: { id: string }) => s.id)).toEqual([s1]);

    // Repeatable status params — the console's All / Suspended / Archived tabs.
    const both = await (await req('/scopes?status=active&status=suspended')).json();
    expect(both).toHaveLength(2);
  });

  it('reads one scope record and fails closed on a cross-tenant pair (K-3)', async () => {
    expect((await req(`/tenants/${t1}/scopes/${s1}`)).status).toBe(200);
    // s1 exists — but not under t2. Indistinguishable from absent, on purpose.
    expect((await req(`/tenants/${t2}/scopes/${s1}`)).status).toBe(404);
  });

  it('walks the lifecycle and maps an illegal transition to 409', async () => {
    const suspended = await json(`/tenants/${t1}/scopes/${s1}/suspend`, 'POST');
    expect(await suspended.json()).toMatchObject({ status: 'suspended' });

    // Only legal transitions exist; the graph is enforced below the seam.
    const illegal = await json(`/tenants/${t1}/scopes/${s1}/unarchive`, 'POST');
    expect(illegal.status).toBe(409);
    expect((await illegal.json()).error).toMatch(/illegal scope transition/);

    const archived = await json(`/tenants/${t1}/scopes/${s1}/archive`, 'POST');
    expect(await archived.json()).toMatchObject({ status: 'archived' });

    const restored = await json(`/tenants/${t1}/scopes/${s1}/unarchive`, 'POST');
    expect(await restored.json()).toMatchObject({ status: 'active' });
  });

  // -- roles (§4.5) ----------------------------------------------------------

  it('lists roles and filters by tenant and source', async () => {
    await host.admin.defineRole(platformActorId.parse(ulid()), t1, {
      key: 'site-manager',
      permissions: [permissionKey.parse('workorder:read')],
      source: 'vertical',
    });
    const roles = await (await req(`/roles?tenantId=${t1}`)).json();
    expect(roles).toHaveLength(1);
    expect(roles[0]).toMatchObject({ tenantId: t1, key: 'site-manager', source: 'vertical' });

    // An unknown source returns nothing rather than 400 — the console filters
    // over sources it has seen, and a typo is an empty list, not an error.
    expect(await (await req('/roles?source=nope')).json()).toEqual([]);
  });

  it('exposes no route that writes a role', async () => {
    // defineRole stays off the wire: creating a role is a permission change, and
    // the permission diff is a human checkpoint.
    expect((await json('/roles', 'POST', { key: 'x', permissions: ['a:b'], source: 'vertical' })).status).toBe(404);
  });

  // -- the admin log (§4.4/§4.5) --------------------------------------------

  it('returns the admin log newest-first with a continuation cursor', async () => {
    const res = await req(`/admin-log?tenantId=${t1}&order=desc&limit=2`);
    const { entries, nextCursor } = await res.json();
    expect(entries).toHaveLength(2);
    expect(nextCursor).toBe(entries[1].id);
    // Newest first: ULID order is chronological.
    expect(entries[0].id > entries[1].id).toBe(true);

    // The cursor carries the page forward with no client-side assembly.
    const page2 = await (await req(`/admin-log?tenantId=${t1}&order=desc&limit=2&cursor=${nextCursor}`)).json();
    expect(page2.entries[0].id < nextCursor).toBe(true);
  });

  it('filters the admin log by action and scope', async () => {
    const { entries } = await (
      await req(`/admin-log?tenantId=${t1}&action=suspendScope&action=archiveScope`)
    ).json();
    expect(entries.length).toBe(2);
    expect(entries.every((e: { action: string }) => ['suspendScope', 'archiveScope'].includes(e.action))).toBe(true);
    // Lifecycle rows carry the scope's vertical — the target, stamped host-side.
    expect(entries.every((e: { vertical: string }) => e.vertical === 'housing')).toBe(true);

    const byScope = await (await req(`/admin-log?scopeId=${s1}`)).json();
    expect(byScope.entries.every((e: { scopeId: string }) => e.scopeId === s1)).toBe(true);
  });

  it('rejects an unknown action filter at the boundary', async () => {
    expect((await req('/admin-log?action=deleteEverything')).status).toBe(400);
  });

  it('returns a null cursor on an empty page', async () => {
    const { entries, nextCursor } = await (
      await req(`/admin-log?tenantId=${tenantId.parse(ulid())}`)
    ).json();
    expect(entries).toEqual([]);
    expect(nextCursor).toBeNull();
  });

  // -- the hostname map (§4.7, K-26) -----------------------------------------

  it('binds a hostname, which does not serve until it is activated', async () => {
    const created = await json('/hostnames', 'POST', {
      hostname: 'ACME.Example.com',
      tenantId: t1,
      scopeId: s1,
      surface: 'app',
      canonical: true,
    });
    expect(created.status).toBe(201);
    const body = await created.json();
    // Normalized at the schema: DNS is case-insensitive, so the map is too.
    expect(body.hostname).toBe('acme.example.com');
    expect(body.status).toBe('pending');
    expect(await host.admin.resolveHostname('acme.example.com')).toBeUndefined();

    const activated = await json('/hostnames/acme.example.com/status', 'PATCH', { status: 'active' });
    expect(activated.status).toBe(200);
    expect((await activated.json()).status).toBe('active');
    expect(await host.admin.resolveHostname('acme.example.com')).toMatchObject({ scopeId: s1 });
  });

  it('lists hostnames, filtered by scope', async () => {
    const all = await (await req('/hostnames')).json();
    expect(all.map((h: { hostname: string }) => h.hostname)).toContain('acme.example.com');
    const forScope = await (await req(`/hostnames?scopeId=${s1}`)).json();
    expect(forScope.every((h: { scopeId: string }) => h.scopeId === s1)).toBe(true);
  });

  it('records a failure reason rather than losing it', async () => {
    await json('/hostnames', 'POST', {
      hostname: 'broken.example.com',
      tenantId: t1,
      scopeId: s1,
      surface: 'app',
    });
    await json('/hostnames/broken.example.com/status', 'PATCH', {
      status: 'failed',
      note: 'DNS validation timed out',
    });
    const rows = await (await req(`/hostnames?scopeId=${s1}`)).json();
    const row = rows.find((h: { hostname: string }) => h.hostname === 'broken.example.com');
    expect(row.status).toBe('failed');
    expect(row.statusNote).toContain('DNS validation');
  });

  it('refuses to move a hostname to another scope over HTTP', async () => {
    const res = await json('/hostnames', 'POST', {
      hostname: 'acme.example.com',
      tenantId: t2,
      scopeId: scopeId.parse(ulid()),
      surface: 'app',
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('rejects a malformed binding at the boundary', async () => {
    expect((await json('/hostnames', 'POST', { hostname: '', tenantId: t1, scopeId: s1, surface: 'app' })).status).toBe(400);
    expect((await json('/hostnames', 'POST', { hostname: 'x.example.com', tenantId: 'nope', scopeId: s1, surface: 'app' })).status).toBe(400);
    expect((await json('/hostnames/acme.example.com/status', 'PATCH', { status: 'sideways' })).status).toBe(400);
  });

  it('audits the staff writes, and does not offer resolveHostname at all', async () => {
    const { entries } = await (await req('/admin-log?action=bindHostname')).json();
    expect(entries.length).toBeGreaterThan(0);
    // The router's per-request read is not a staff action and has no route here
    // (K-24). A 404 rather than a resolution is the point.
    expect((await req('/hostnames/acme.example.com/resolve')).status).toBe(404);
  });

  // -- instances (K-31) -------------------------------------------------------

  it('501s for a vertical with no deployment bound, rather than pretending', async () => {
    // A control plane that silently does nothing is worse than one that says it
    // cannot: the caller would believe an instance exists.
    const res = await json('/verticals/ghost/instances', 'POST', {
      tenantId: t1,
      scopeId: scopeId.parse(ulid()),
      owner: ulid(),
      slug: 'acme',
      name: 'Acme AB',
    });
    expect(res.status).toBe(501);
  });

  it('calls the vertical, presenting the platform secret', async () => {
    let seen: Request | undefined;
    const vertical = new VerticalClient({
      platformSecret: 'shhh',
      fetch: (async (url: string, init: RequestInit) => {
        seen = new Request(url, init);
        return new Response(
          JSON.stringify({ tenantId: t1, scopeId: s1, owner: '01JZ00000000000000000000OW' }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        );
      }) as unknown as typeof fetch,
    });
    const withVertical = createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      verticals: { fsm: vertical },
    });

    const res = await withVertical.request('/verticals/fsm/instances', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        tenantId: t1,
        scopeId: s1,
        owner: '01JZ00000000000000000000OW',
        slug: 'acme',
        name: 'Acme AB',
      }),
    });

    expect(res.status).toBe(201);
    expect(seen?.headers.get('x-substrat-platform')).toBe('shhh');
    expect(new URL(seen!.url).pathname).toBe('/internal/provision');
  });

  it('surfaces a refusal from the vertical rather than swallowing it', async () => {
    // A 403 here means the secrets do not match — a deployment error someone must
    // see, not a transient failure to paper over.
    const vertical = new VerticalClient({
      platformSecret: 'wrong',
      fetch: (async () =>
        new Response(JSON.stringify({ error: 'not a platform call' }), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        })) as unknown as typeof fetch,
    });
    const withVertical = createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      verticals: { fsm: vertical },
    });

    const res = await withVertical.request('/verticals/fsm/instances', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        tenantId: t1,
        scopeId: scopeId.parse(ulid()),
        owner: '01JZ00000000000000000000OW',
        slug: 'acme',
        name: 'Acme AB',
      }),
    });
    expect(res.status).toBe(403);
  });

  it('still requires an actor', async () => {
    const res = await app.request('/verticals/fsm/instances', {
      method: 'POST',
      body: JSON.stringify({ tenantId: t1, scopeId: s1, owner: 'x', slug: 'a', name: 'A' }),
    });
    expect(res.status).toBe(401);
  });
});
