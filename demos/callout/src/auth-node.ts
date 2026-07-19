import { join } from 'node:path';
import Database from 'better-sqlite3';
import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';

/**
 * Better Auth as the fsm demo's NODE authentication adapter — the same "second
 * adapter" (D-16) the Worker runs on D1, here backed by `better-sqlite3`. It owns
 * identity, credentials and sessions in its OWN store, entirely separate from the
 * scope-host DBs and the control-plane directory. Authentication only: the kernel
 * keeps authorization (roles/grants/tenancy), so Better Auth's organization/RBAC
 * plugins stay off by design.
 *
 * Node-only (`better-sqlite3`, `node:path`) — harness code, exactly like the
 * shop demo's `auth.ts`. The runtime-agnostic seam lives in `auth-adapters.ts`.
 *
 * `baseURL`/`trustedOrigins` must include the WEB origin (the app's Vite dev
 * server), because the browser calls /api/auth/* through Vite's proxy and Better
 * Auth checks the request Origin against that list — get it wrong and login fails
 * with "Invalid origin" or the session cookie won't stick.
 */
export function buildAuthNode(dir: string, baseURL: string, trustedOrigins: string[]) {
  const db = new Database(join(dir, 'better-auth.sqlite'));
  db.pragma('journal_mode = WAL');
  // Typed as BetterAuthOptions so the instance's type doesn't leak the
  // better-sqlite3 Database type through the exported factory's return.
  const options: BetterAuthOptions = {
    database: db,
    emailAndPassword: { enabled: true, autoSignIn: true, minPasswordLength: 8 },
    secret: process.env.BETTER_AUTH_SECRET ?? 'dev-only-secret-substrat-callout-demo-32chars',
    baseURL,
    trustedOrigins,
  };
  return betterAuth(options);
}

/** The concrete Better Auth instance type (kept precise for the server to consume). */
export type AuthNode = ReturnType<typeof buildAuthNode>;

/** Create Better Auth's own tables (user/session/account/verification) if absent. */
export async function migrateAuth(auth: AuthNode): Promise<void> {
  const { runMigrations } = await getMigrations(auth.options);
  await runMigrations();
}
