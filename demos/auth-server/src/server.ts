import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import {
  MockEmailTransport,
  type EmailMessage,
  type EmailTransport,
  type SendResult,
} from '@substrat-run/adapter-email';
import { resolveEnvSpec } from '@substrat-run/contracts';
import { schema } from './auth-schema.js';
import { SCHEMA_STATEMENTS } from '../db/ddl.js';
import { buildAuth, DEMO_CLIENT } from './auth.js';
import { senderFor } from './email.js';
import { AUTH_SERVER_ENV } from './manifest.js';

/**
 * Dev API server for the auth-server demo — Better Auth over a local better-sqlite3 file,
 * the exact same `buildAuth` config the worker's Durable Object runs. No Durable Object and
 * no Cloudflare account needed: this is the fast inner loop for the OIDC provider + admin UI.
 *
 * Email has no real sending domain in dev, so the transport is a mock that ALSO logs each
 * message — a password-reset or verification link is printed to this terminal, where you can
 * click it. That is the demo's "email adapter" made observable.
 */

const dataDir = join(dirname(fileURLToPath(import.meta.url)), '..', '.data');
mkdirSync(dataDir, { recursive: true });

const PORT = Number(process.env.PORT ?? 8877);
const WEB_PORT = Number(process.env.WEB_PORT ?? 5277);
const ORIGIN = `http://localhost:${PORT}`;

/** A mock transport that also prints each message (and its action link) to the terminal. */
class LoggingMockTransport extends MockEmailTransport {
  override async send(message: EmailMessage): Promise<SendResult> {
    const result = await super.send(message);
    const to = Array.isArray(message.to) ? message.to.map((r) => (typeof r === 'string' ? r : r.email)).join(', ') : typeof message.to === 'string' ? message.to : message.to.email;
    const link = /(https?:\/\/\S+)/.exec(message.text)?.[1];
    console.log(`\n  📧 ${message.subject}  → ${to}`);
    if (link) console.log(`     ${link}\n`);
    return result;
  }
}

const transport: EmailTransport = new LoggingMockTransport();

// Resolve the declared config through the manifest env-spec — the same keys the worker DO
// reads, so the manifest is the single source of what the issuer consumes.
const cfg = resolveEnvSpec(AUTH_SERVER_ENV, process.env).values;

const sqlite = new Database(join(dataDir, 'auth.sqlite'));
sqlite.pragma('journal_mode = WAL');
for (const stmt of SCHEMA_STATEMENTS) sqlite.exec(stmt);
const db = drizzle(sqlite, { schema });

const auth = buildAuth({
  database: drizzleAdapter(db, { provider: 'sqlite', schema }),
  secret: process.env.AUTH_SECRET ?? 'dev-secret-not-for-production-000000000000',
  baseURL: ORIGIN,
  trustedOrigins: [ORIGIN, `http://localhost:${WEB_PORT}`],
  transport,
  sender: senderFor(cfg.EMAIL_FROM),
});

const needsSetup = (): boolean => (sqlite.prepare('SELECT count(*) AS n FROM user').get() as { n: number }).n === 0;

// Bootstrap admin from the env (ADMIN_EMAIL/ADMIN_PASSWORD), same contract as the worker DO,
// falling back to the demo defaults so `pnpm dev` runs with zero config.
const ADMIN_EMAIL = cfg.ADMIN_EMAIL ?? 'admin@auth.test';
const ADMIN_PASSWORD = cfg.ADMIN_PASSWORD ?? 'admin-demo-pass';

/** Seed the administrator so you can sign into the dashboard immediately. Idempotent. */
async function seedAdmin(): Promise<void> {
  const existing = sqlite.prepare('SELECT id FROM user WHERE email = ?').get(ADMIN_EMAIL) as { id: string } | undefined;
  if (existing) return;
  const created = await auth.api.signUpEmail({ body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD, name: 'Administrator' } });
  sqlite.prepare("UPDATE user SET role = 'admin', email_verified = 1 WHERE id = ?").run(created.user.id);
}
await seedAdmin();

const app = new Hono();

app.get('/api/setup-state', (c) => c.json({ needsSetup: needsSetup() }));

app.post('/api/setup', async (c) => {
  const body = await c.req.json<{ email?: string; password?: string; name?: string }>();
  if (!body.email || !body.password || !body.name) throw new HTTPException(400, { message: 'email, password and name are required' });
  if (!needsSetup()) throw new HTTPException(409, { message: 'the auth server is already set up' });
  const created = await auth.api.signUpEmail({ body: { email: body.email, password: body.password, name: body.name } });
  sqlite.prepare("UPDATE user SET role = 'admin', email_verified = 1 WHERE id = ?").run(created.user.id);
  return c.json({ ok: true, id: created.user.id }, 201);
});

app.get('/api/session', async (c) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  const u = session?.user as { id: string; email?: string; name?: string; role?: string } | undefined;
  return c.json(u ? { sub: u.id, email: u.email ?? null, name: u.name ?? null, role: u.role ?? null } : null);
});

// Root-level OIDC discovery alias → Better Auth serves it under the base path. (The cast
// steps past the node/undici vs Better-Auth `Request` lib mismatch; the shape is identical.)
app.get('/.well-known/openid-configuration', async (c) => {
  const res = await auth.handler(
    new Request(`${ORIGIN}/api/auth/.well-known/openid-configuration`, { headers: c.req.raw.headers }) as never,
  );
  return c.body(await res.text(), 200, { 'content-type': 'application/json' });
});

// The whole Better Auth surface (sign-in, reset, OIDC, admin API).
app.on(['GET', 'POST', 'OPTIONS'], '/api/auth/*', (c) => auth.handler(c.req.raw));

app.onError((err, c) => {
  const status = err instanceof HTTPException ? err.status : 400;
  return c.json({ error: err instanceof Error ? err.message : String(err) }, status);
});

serve({ fetch: app.fetch, port: PORT });
console.log(`\n  Auth Server demo (OIDC provider)  ${ORIGIN}`);
console.log(`  admin dashboard                   http://localhost:${WEB_PORT}`);
console.log(`  discovery                         ${ORIGIN}/.well-known/openid-configuration`);
console.log(`  seeded admin                      ${ADMIN_EMAIL} / ${ADMIN_PASSWORD}`);
console.log(`  demo relying party                client_id=${DEMO_CLIENT.clientId}  (redirect ${DEMO_CLIENT.redirectUrls[0]})`);
console.log(`  data                              ${dataDir}\n`);
