import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { serve } from '@hono/node-server';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import {
  platformActorId,
  type PrincipalId,
  type ScopeId,
  type TenantId,
} from '@substrat-run/contracts';
import { ulid, type ScopeStub } from '@substrat-run/kernel';
import {
  createControlPlaneApi,
  UNSAFE_devPlatformActorAuth,
} from '@substrat-run/control-plane-api';
import { buildDemoHost, seedDemo, type DemoWorld } from './index.js';
import { buildAuthNode, migrateAuth } from './auth-node.js';
import { mountApi } from './routes.js';
import {
  betterAuthAdapter,
  devHeaderAdapter,
  resolvePrincipal,
  type AuthAdapter,
  type AuthResult,
} from './auth-adapters.js';

/**
 * Dev API server for the FSM demo. Deliberately thin: resolve the principal
 * (Better Auth session, or the opt-in dev-header fallback) → getScope → invoke.
 * Every route is a wrapper over an operation; there is no business logic here.
 *
 * Better Auth is now the primary auth on BOTH entrypoints (this node server and
 * the Cloudflare Worker), sharing the runtime-agnostic seam in `auth-adapters.ts`.
 * The old `x-principal` persona picker (`/api/cast`) is retired.
 */

const dataDir = join(dirname(fileURLToPath(import.meta.url)), '..', '.data');
mkdirSync(dataDir, { recursive: true });

// Dev ports sit in a private 887x/527x block, clear of the Vite (5173) and
// Wrangler (8787) defaults that every other project on the machine also wants.
// Override without editing: PORT=… WEB_PORT=… pnpm fsm-demo dev
const port = Number(process.env.PORT ?? 8871);
const webPort = Number(process.env.WEB_PORT ?? 5271);
// The shared control plane rides the SAME SqliteScopeHost on its own port (the
// console's dev proxy default). One process, one host, one SQLite dir: the
// directory the console reads and acts on IS the directory this vertical's
// getScope gates against, so a suspend in the console fails this vertical's next
// operation closed — the whole flow, no Cloudflare, no second store. In
// production these are separate deployments reaching one durable directory; the
// co-location here is a local-dev convenience, not the topology.
const cpPort = Number(process.env.CP_PORT ?? 8788);
// The fsm app's Vite dev origin — the browser calls /api/auth/* through its proxy
// (see app/vite.config.ts, which reads the same two vars), so Better Auth must
// trust it as an origin or login fails with "Invalid origin" / cookies won't stick.
const webOrigin = process.env.WEB_ORIGIN ?? `http://localhost:${webPort}`;

const host = buildDemoHost(dataDir);
const world: DemoWorld = await seedDemo(host, dataDir);

// Node Better Auth — its own better-sqlite3 store, migrated on startup, then seed
// the persona logins. baseURL is the web origin; both the web origin and the API
// port are trusted (raw curl against the API uses the API port's own origin).
const auth = buildAuthNode(dataDir, webOrigin, [webOrigin, `http://localhost:${port}`]);
await migrateAuth(auth);

// Each demo persona gets a Better Auth login bound to its OWN principal +
// tenant/scope through the neutral identity seam. Mallory lives in t2/s2 (a
// different tenant) — logging in as her lands in t2, proving the isolation.
interface NodePersona {
  email: string;
  password: string;
  name: string;
  principal: PrincipalId;
  tenantId: TenantId;
  scopeId: ScopeId;
}
const NODE_PERSONAS: NodePersona[] = [
  { email: 'anna@elmontage.se', password: 'demo1234', name: 'Anna (kontor)', principal: world.anna, tenantId: world.t1, scopeId: world.s1 },
  { email: 'harald@elmontage.se', password: 'demo1234', name: 'Harald (tekniker)', principal: world.harald, tenantId: world.t1, scopeId: world.s1 },
  { email: 'berit@brfgrunden.se', password: 'demo1234', name: 'Berit (portal, BRF Grunden)', principal: world.berit, tenantId: world.t1, scopeId: world.s1 },
  { email: 'styrbjorn@kontorshotellet.se', password: 'demo1234', name: 'Styrbjörn (portal, Kontorshotellet)', principal: world.styrbjorn, tenantId: world.t1, scopeId: world.s1 },
  { email: 'mallory@rorservice.se', password: 'demo1234', name: 'Mallory (annan firma!)', principal: world.mallory, tenantId: world.t2, scopeId: world.s2 },
];

async function seedPersonaLogins(): Promise<void> {
  const staff = platformActorId.parse(ulid());
  const db = new Database(join(dataDir, 'better-auth.sqlite'), { readonly: true });
  try {
    for (const p of NODE_PERSONAS) {
      let userId: string | undefined;
      try {
        const res = await auth.api.signUpEmail({
          body: { email: p.email, password: p.password, name: p.name },
        });
        userId = res.user.id;
      } catch {
        // Already exists — read the id back from Better Auth's own store.
        userId = (db.prepare('SELECT id FROM user WHERE email = ?').get(p.email) as
          | { id: string }
          | undefined)?.id;
      }
      if (userId) {
        await host.admin.linkIdentity(staff, {
          provider: 'better-auth',
          externalId: userId,
          principal: p.principal,
          tenantId: p.tenantId,
          scopeId: p.scopeId,
        });
      }
    }
  } finally {
    db.close();
  }
}
await seedPersonaLogins();

// Mounted auth adapters, in precedence order: a real Better Auth session wins.
// The `x-principal` dev-header adapter is an impersonation bypass by design, so
// it is mounted ONLY when ALLOW_DEV_HEADER=true (parity with the worker) —
// secure by default, off unless explicitly opted in.
const adapters: AuthAdapter[] = [betterAuthAdapter(auth, host, { tenantId: world.t1, scopeId: world.s1 })];
if (process.env.ALLOW_DEV_HEADER === 'true') {
  adapters.push(devHeaderAdapter({ tenantId: world.t1, scopeId: world.s1 }));
}

const app = new Hono();

// Better Auth owns everything under /api/auth/* (sign-up, sign-in, session, …).
app.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw));

// The resolved identity behind the current request (principal, display, role), or 401.
app.get('/api/me', async (c) => {
  const r = await resolvePrincipal(adapters, c.req.raw.headers);
  if (!r) return c.json({ error: 'unauthorized' }, 401);
  return c.json({
    principal: r.principal,
    display: r.display,
    role: r.role,
    via: r.via,
    tenant: r.tenantId,
    scope: r.scopeId,
  });
});

// A protected route resolves the caller across the mounted adapters, then getScope
// for the RESOLVED tenant/scope (so mallory lands in t2/s2). None matched → 401.
async function stub(c: Context): Promise<ScopeStub> {
  const r: AuthResult | null = await resolvePrincipal(adapters, c.req.raw.headers);
  if (!r) throw new HTTPException(401, { message: 'unauthorized' });
  return host.getScope(r.principal, r.tenantId, r.scopeId);
}

// The whole data API — shared with the Cloudflare Worker (src/routes.ts), which
// also installs the shared fail-closed error handler.
mountApi(app, stub);

serve({ fetch: app.fetch, port });

// The shared control plane over the same `host`. UNSAFE dev-actor auth is the
// only posture a local stub may take (control-plane.md §6); this listener binds
// localhost only. Any valid ULID is accepted as the platform actor — the console
// defaults to CONSOLE_ACTOR via VITE_DEV_ACTOR, so it authenticates with no
// copy-paste.
const controlPlane = createControlPlaneApi({
  host,
  authenticate: UNSAFE_devPlatformActorAuth(),
});
serve({ fetch: controlPlane.fetch, port: cpPort, hostname: '127.0.0.1' });

// One consolidated banner instead of scattered log lines, so `pnpm dev` ends on a
// clear "open this" pointer rather than interleaved startup noise. The console and
// app URLs are only shown under the root stack (SUBSTRAT_STACK=1) — running this
// server alone doesn't start those Vite processes, and a banner that named URLs
// nothing is serving would be a lie. The console dev port is a fixed convention
// (apps/console/vite.config.ts defaults WEB_PORT to 5272).
const inStack = process.env.SUBSTRAT_STACK === '1';
const consolePort = Number(process.env.CONSOLE_PORT ?? 5272);
const lines = [
  '',
  `  substrat · ${inStack ? 'local stack' : 'ServiceCo API'} — one process, one SQLite dir`,
  '  ' + '─'.repeat(52),
  ...(inStack
    ? [
        `    ▶ Console (open this)   http://localhost:${consolePort}`,
        `    ▶ Portal — ServiceCo    http://localhost:${webPort}`,
        '',
      ]
    : []),
  `      vertical API          http://localhost:${port}`,
  `      control plane API     http://localhost:${cpPort}`,
  '  ' + '─'.repeat(52),
  `    data   ${dataDir}`,
  `    auth   ${adapters.map((a) => a.id).join(', ')}`,
  '',
];
console.log(lines.join('\n'));
