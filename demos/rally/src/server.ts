import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { serve } from '@hono/node-server';
import { buildRallyHost, seedRally, type RallyWorld } from './index.js';
import { createRallyApp } from './routes.js';

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
const app = createRallyApp(host, world);

// Private 887x/527x block — see each app's vite.config.ts. PORT moves the API,
// PLAYER_PORT / CONSOLE_PORT move the two web ends.
const PORT = Number(process.env.PORT ?? 8877);
const PLAYER_PORT = Number(process.env.PLAYER_PORT ?? 5277);
const CONSOLE_PORT = Number(process.env.CONSOLE_PORT ?? 5278);

serve({ fetch: app.fetch, port: PORT });
console.log(`\n  RallyPoint demo API   http://localhost:${PORT}`);
console.log(`  player app            http://localhost:${PLAYER_PORT}`);
console.log(`  manager console       http://localhost:${CONSOLE_PORT}`);
console.log(`  data in ${dataDir}\n`);
