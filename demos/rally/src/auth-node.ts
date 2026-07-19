import { join } from 'node:path';
import Database from 'better-sqlite3';
import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';

/**
 * Better Auth as RallyPoint's authentication adapter (D-16: identity is a swappable
 * adapter, ours is the reference implementation). It owns identity, credentials and
 * sessions in its OWN store, entirely separate from the scope databases and the
 * control-plane directory. Authentication only — the kernel keeps authorization
 * (roles, grants, tenancy), so Better Auth's organization and RBAC plugins stay off
 * by design.
 *
 * Node-only (`better-sqlite3`, `node:path`) — harness code. The runtime-agnostic
 * seam lives in `auth-adapters.ts`.
 *
 * `baseURL`/`trustedOrigins` must include the WEB origins, because the browser calls
 * `/api/auth/*` through Vite's proxy and Better Auth checks Origin against that list.
 * RallyPoint has TWO app origins — the player app and the manager console — so both
 * belong here or login silently fails on one of them.
 */
export function buildAuthNode(dir: string, baseURL: string, trustedOrigins: string[]) {
  const db = new Database(join(dir, 'better-auth.sqlite'));
  db.pragma('journal_mode = WAL');
  const options: BetterAuthOptions = {
    database: db,
    emailAndPassword: { enabled: true, autoSignIn: true, minPasswordLength: 8 },
    secret: process.env.BETTER_AUTH_SECRET ?? 'dev-only-secret-substrat-rally-demo-32chars',
    baseURL,
    trustedOrigins,
  };
  return betterAuth(options);
}

export type AuthNode = ReturnType<typeof buildAuthNode>;

/** Create Better Auth's own tables (user/session/account/verification) if absent. */
export async function migrateAuth(auth: AuthNode): Promise<void> {
  const { runMigrations } = await getMigrations(auth.options);
  await runMigrations();
}
