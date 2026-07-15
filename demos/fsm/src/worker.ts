/**
 * ServiceCo (the FSM demo vertical) as a deployable Cloudflare Worker.
 *
 * This is the same vertical the pure-SQLite demo runs, deployed onto the
 * Durable-Object adapter: one `ScopeDO` per scope (kernel + engines + the
 * ServiceCo module bundled in), a durable `ControlPlaneDO` directory, and a thin
 * Hono API that authenticates → getScope → invoke. Proof that a vertical runs on
 * the real Cloudflare runtime with every kernel guarantee below the API surface.
 *
 * Local run:  wrangler dev            (real workerd, no account)
 * Deploy:     wrangler deploy         (needs a Workers Paid plan — DO SQLite)
 */
import { Hono } from 'hono';
import {
  principalId,
  scopeId,
  tenantId,
  platformActorId,
  type PrincipalId,
} from '@substrat-run/contracts';
import { defineScopeDO, ControlPlaneDO, CloudflareScopeHost } from '@substrat-run/adapter-cloudflare';
import { workorderModule, PERM as WO } from '@substrat-run/engine-workorder';
import { invoicingModule, INVOICING_PERM as INV } from '@substrat-run/engine-invoicing';
import { protocolModule, PROTOCOL_PERM as PROTO } from '@substrat-run/engine-protocol';
import { servicecoModule, SC_PERM } from './module.js';

// Registration order is a migration-ordering contract (protocol before serviceco).
const MODULES = [workorderModule, invoicingModule, protocolModule, servicecoModule];

/** The scope-DO class = the app binary: kernel + engines + ServiceCo, bundled. */
export const ScopeDO = defineScopeDO(MODULES, {});
export { ControlPlaneDO };

// Fixed demo identifiers (valid ULIDs). One tenant, one scope, one office admin.
const T = tenantId.parse('01JZ0000000000000000000001');
const S = scopeId.parse('01JZ0000000000000000000002');
const ANNA = principalId.parse('01JZ0000000000000000000003');
const STAFF = platformActorId.parse('01JZ0000000000000000000005');

interface Env {
  SCOPE: DurableObjectNamespace;
  CONTROL_PLANE: DurableObjectNamespace;
}

/** The coordinator is stateless — rebuilt per request; durable state is in the DOs. */
function hostFor(env: Env): CloudflareScopeHost {
  const host = new CloudflareScopeHost({ scope: env.SCOPE, controlPlane: env.CONTROL_PLANE });
  for (const m of MODULES) host.registerModule(m);
  return host;
}

/** Dev auth: `x-principal` header picks the caller; defaults to the office admin. */
function principalOf(header: string | undefined): PrincipalId {
  return principalId.parse(header ?? ANNA);
}

const app = new Hono<{ Bindings: Env }>();

app.get('/', (c) =>
  c.json({
    ok: true,
    vertical: 'ServiceCo (fsm) on Cloudflare Durable Objects',
    hint: 'POST /api/seed once, then GET/POST /api/customers and /api/workorders',
  }),
);

// One-time (idempotent) provisioning of the demo world.
app.post('/api/seed', async (c) => {
  const host = hostFor(c.env);
  await host.admin.createTenant(STAFF, { id: T, slug: 'elmontage', name: 'ElMontage AB' });
  for (const key of ['workorder', 'invoicing', 'protocol', 'serviceco']) {
    await host.admin.grantEntitlement(STAFF, T, key);
  }
  await host.provisionScope(STAFF, { tenantId: T, scopeId: S, jurisdiction: 'eu' });
  await host.admin.defineRole(STAFF, T, {
    key: 'office-admin',
    permissions: [
      SC_PERM.customerManage, SC_PERM.facilityManage,
      WO.create, WO.read, WO.assign, WO.report, WO.complete, WO.close,
      INV.read, INV.export,
      PROTO.create, PROTO.fill, PROTO.sign, PROTO.read, PROTO.void,
    ],
    source: 'vertical',
  });
  await host.admin.assignRole(STAFF, {
    principalId: ANNA,
    roleKey: 'office-admin',
    node: { tenantId: T, scopeId: null },
  });
  return c.json({ seeded: true, tenant: T, scope: S, principal: ANNA });
});

const stub = (c: { env: Env; req: { header(n: string): string | undefined } }) =>
  hostFor(c.env).getScope(principalOf(c.req.header('x-principal')), T, S);

app.get('/api/customers', async (c) => c.json(await (await stub(c)).invoke('serviceco/list-customers')));
app.post('/api/customers', async (c) =>
  c.json(await (await stub(c)).invoke('serviceco/create-customer', await c.req.json())),
);
app.post('/api/facilities', async (c) =>
  c.json(await (await stub(c)).invoke('serviceco/create-facility', await c.req.json())),
);
app.get('/api/prices', async (c) => c.json(await (await stub(c)).invoke('serviceco/price-list')));
app.post('/api/prices', async (c) =>
  c.json(await (await stub(c)).invoke('serviceco/upsert-price', await c.req.json())),
);
app.get('/api/workorders', async (c) =>
  c.json(await (await stub(c)).invoke('workorder/list', { status: c.req.query('status') })),
);
app.post('/api/workorders', async (c) =>
  c.json(await (await stub(c)).invoke('serviceco/create-workorder', await c.req.json())),
);
app.get('/api/workorders/:id', async (c) =>
  c.json(await (await stub(c)).invoke('workorder/get', { orderId: c.req.param('id') })),
);

// Fail closed → JSON. A permission or invariant violation is a 4xx, not a 500.
app.onError((err, c) => c.json({ error: (err as Error).message }, 400));

export default app;
