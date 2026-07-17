import { join } from 'node:path';
import Database from 'better-sqlite3';
import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import type { StaffSessionReader } from '../src/index.js';

/**
 * Better Auth as the control plane's STAFF authentication — the real end of §6's
 * identity seam, for the small closed set of platform operators (not tenant
 * users). Its own store (`staff-auth.sqlite`), separate from the directory and
 * every scope DB. Authentication only: who counts as staff, and under which
 * actor id, is the `staffAllowlist` in the server — Better Auth just proves the
 * email.
 *
 * Node-only harness (better-sqlite3), exactly like the demo's `auth-node.ts`.
 * When this moves to AuthHero, only the session reader below changes; the router,
 * the allowlist, and the console's login calls stay put.
 *
 * `basePath: '/auth'` matches the console's dev proxy, which strips `/api` before
 * forwarding, so the browser's `/api/auth/*` arrives here as `/auth/*`.
 * `trustedOrigins` must include the console's Vite origin or sign-in fails the
 * Origin check and the session cookie won't stick.
 */
export function buildStaffAuth(dir: string, baseURL: string, trustedOrigins: string[]) {
  const db = new Database(join(dir, 'staff-auth.sqlite'));
  db.pragma('journal_mode = WAL');
  const options: BetterAuthOptions = {
    database: db,
    basePath: '/auth',
    emailAndPassword: { enabled: true, autoSignIn: true, minPasswordLength: 8 },
    secret: process.env.BETTER_AUTH_SECRET ?? 'dev-only-secret-substrat-control-plane-32c',
    baseURL,
    trustedOrigins,
  };
  return betterAuth(options);
}

export type StaffAuth = ReturnType<typeof buildStaffAuth>;

/** Create Better Auth's own tables (user/session/account/verification) if absent. */
export async function migrateStaffAuth(auth: StaffAuth): Promise<void> {
  const { runMigrations } = await getMigrations(auth.options);
  await runMigrations();
}

/** Adapts Better Auth's session to the provider-agnostic `StaffSessionReader`. */
export function staffSessionReader(auth: StaffAuth): StaffSessionReader {
  return async (headers) => {
    const session = await auth.api.getSession({ headers });
    return session?.user?.email ? { email: session.user.email } : null;
  };
}
