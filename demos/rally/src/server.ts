import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import Database from 'better-sqlite3';
import { buildRallyHost, seedRally, type RallyWorld } from './index.js';
import { createRallyApp } from './routes.js';
import { buildAuthNode, migrateAuth } from './auth-node.js';
import { betterAuthAdapter, devHeaderAdapter, type AuthAdapter } from './auth-adapters.js';
import { linkRallyLogins } from './seed.js';

/**
 * Dev API server for the RallyPoint demo — bootstrap only. The routes live in
 * app.ts so the same app can be driven by tests without a socket.
 *
 * Two web apps sit in front of this one API — the player app (:5277) and the
 * manager console (:5278). The split is chrome and audience, never a second
 * source of truth.
 */

const dataDir = join(dirname(fileURLToPath(import.meta.url)), '..', '.data');
mkdirSync(dataDir, { recursive: true });

const host = buildRallyHost(dataDir);
const world: RallyWorld = await seedRally(host, dataDir);

// Private 887x/527x block — see each app's vite.config.ts. PORT moves the API,
// PLAYER_PORT / CONSOLE_PORT move the two web ends.
const PORT = Number(process.env.PORT ?? 8877);
const PLAYER_PORT = Number(process.env.PLAYER_PORT ?? 5277);
const CONSOLE_PORT = Number(process.env.CONSOLE_PORT ?? 5278);

// BOTH app origins are trusted: the browser calls /api/auth/* through Vite's
// proxy and Better Auth checks Origin against this list, so omitting one makes
// login fail on that app only — which is a confusing way to find out.
const auth = buildAuthNode(dataDir, `http://localhost:${PORT}`, [
  `http://localhost:${PORT}`,
  `http://localhost:${PLAYER_PORT}`,
  `http://localhost:${CONSOLE_PORT}`,
]);
await migrateAuth(auth);
/**
 * Demo logins for the cast, so the template runs with a real session out of the
 * box rather than only with the dev header.
 *
 * Idempotent on both sides: sign-up throws if the email exists, in which case the
 * id is read back, and `linkRallyLogins` skips anyone already bound. The two
 * stores have independent lifecycles — the world can exist while Better Auth's
 * tables are fresh — so neither may assume the other is empty.
 */
const PERSONAS = [
  { email: 'astrid@rallypoint.se', name: 'Astrid', principal: world.astrid, tenantId: world.t1, scopeId: world.s1 },
  { email: 'ravi@rallypoint.se', name: 'Ravi', principal: world.ravi, tenantId: world.t1, scopeId: world.s1 },
  { email: 'nils@rallypoint.se', name: 'Nils', principal: world.nils, tenantId: world.t1, scopeId: world.s1 },
  { email: 'elin@example.se', name: 'Elin', principal: world.elin, tenantId: world.t1, scopeId: world.s1 },
  { email: 'johan@example.se', name: 'Johan', principal: world.johan, tenantId: world.t1, scopeId: world.s1 },
  // Another club entirely — the tenant-boundary beat. One pool, many tenants is
  // exactly what `central` topology means.
  { email: 'rutger@padelcenter.se', name: 'Rutger', principal: world.rutger, tenantId: world.t2, scopeId: world.s2 },
];

const authDb = new Database(join(dataDir, 'better-auth.sqlite'), { readonly: true });
const linked: Parameters<typeof linkRallyLogins>[2] = [];
try {
  for (const p of PERSONAS) {
    let externalId: string | undefined;
    try {
      externalId = (
        await auth.api.signUpEmail({
          body: { email: p.email, password: 'rallypoint-demo', name: p.name },
        })
      ).user.id;
    } catch {
      externalId = (
        authDb.prepare('SELECT id FROM user WHERE email = ?').get(p.email) as { id: string } | undefined
      )?.id;
    }
    if (externalId) linked.push({ externalId, principal: p.principal, tenantId: p.tenantId, scopeId: p.scopeId });
  }
} finally {
  authDb.close();
}
await linkRallyLogins(host, world, linked);

/**
 * Real auth first; the dev header only if explicitly opted in.
 *
 * A template teaches by example, so the example is a session — not a header that
 * names whoever it likes. The header stays for local iteration because it is
 * genuinely useful, and stays OFF by default because a copied template inherits
 * its defaults.
 */
const adapters: AuthAdapter[] = [betterAuthAdapter(auth, host)];
if (process.env.ALLOW_DEV_HEADER === 'true') adapters.push(devHeaderAdapter());

const app = new Hono();
app.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw));
app.route('/', createRallyApp(host, world, adapters));

serve({ fetch: app.fetch, port: PORT });
console.log(`\n  RallyPoint demo API   http://localhost:${PORT}`);
console.log(`  player app            http://localhost:${PLAYER_PORT}`);
console.log(`  manager console       http://localhost:${CONSOLE_PORT}`);
console.log(`  data in ${dataDir}\n`);
