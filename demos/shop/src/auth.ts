import { join } from 'node:path';
import Database from 'better-sqlite3';
import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';

/**
 * Better Auth as the shop demo's authentication adapter — the "second adapter"
 * behind the neutral kernel identity seam (D-16). It owns identity, credentials
 * and sessions in its OWN store, entirely separate from the scope-host DBs and
 * the control-plane directory. Authentication only: the kernel keeps
 * authorization (roles/grants/tenancy), so Better Auth's organization/RBAC
 * plugins stay off by design.
 *
 * OIDC/social/SSO are later config on THIS same adapter (Better Auth federates
 * them upstream), needing no kernel change — the point of doing the seam neutrally.
 */
export function buildAuth(dir: string, port: number, webOrigin: string) {
  const db = new Database(join(dir, 'better-auth.sqlite'));
  db.pragma('journal_mode = WAL');
  // Typed as BetterAuthOptions so the instance's type doesn't leak the
  // better-sqlite3 Database type through the exported factory's return.
  const options: BetterAuthOptions = {
    database: db,
    emailAndPassword: { enabled: true, autoSignIn: true, minPasswordLength: 8 },
    secret: process.env.BETTER_AUTH_SECRET ?? 'dev-only-secret-substrat-shop-demo-32chars',
    baseURL: `http://localhost:${port}`,
    // The storefront calls /api/auth/* through Vite's proxy, so its origin must be trusted.
    trustedOrigins: [webOrigin, `http://localhost:${port}`],
  };
  return betterAuth(options);
}

/** The concrete Better Auth instance type (kept precise for the adapter to consume). */
export type Auth = ReturnType<typeof buildAuth>;

/** Create Better Auth's own tables (user/session/account/verification) if absent. */
export async function migrateAuth(auth: Auth): Promise<void> {
  const { runMigrations } = await getMigrations(auth.options);
  await runMigrations();
}
