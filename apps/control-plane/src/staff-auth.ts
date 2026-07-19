import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { drizzle } from 'drizzle-orm/d1';
import type { StaffSessionReader } from '@substrat-run/control-plane-api';
import * as schema from './auth-schema.js';

/**
 * Better Auth as the control plane's STAFF authentication on the edge — the
 * worker counterpart of the dev server's staff auth, on Cloudflare D1 via
 * Drizzle (the demo's `auth.ts` pattern, for platform staff instead of tenant
 * users). Authentication only: who counts as staff, and under which actor id, is
 * the D1 staff roster (`staff-roster.ts`) — Better Auth just proves the email.
 *
 * workerd-safe (no `node:*`, no better-sqlite3). Rebuilt per request; durable
 * state lives in D1. `origin` is the request origin, trusted as baseURL so the
 * origin/CSRF check passes on any deployment with no config. When this moves to
 * AuthHero, only the session reader below changes.
 */
export interface StaffAuthEnv {
  AUTH_DB: D1Database;
  BETTER_AUTH_SECRET?: string;
  BASE_URL?: string;
}

export function buildStaffAuth(env: StaffAuthEnv, origin?: string) {
  const baseURL = origin ?? env.BASE_URL ?? 'http://localhost:8787';
  const trustedOrigins = [...new Set([baseURL, env.BASE_URL].filter((o): o is string => !!o))];
  const db = drizzle(env.AUTH_DB, { schema });
  return betterAuth({
    database: drizzleAdapter(db, { provider: 'sqlite', schema }),
    emailAndPassword: { enabled: true, autoSignIn: true, minPasswordLength: 8 },
    secret: env.BETTER_AUTH_SECRET ?? 'dev-only-secret-substrat-control-plane-32c',
    baseURL,
    trustedOrigins,
  });
}

export type StaffAuth = ReturnType<typeof buildStaffAuth>;

/** Adapts Better Auth's session to the provider-agnostic `StaffSessionReader`. */
export function staffSessionReader(auth: StaffAuth): StaffSessionReader {
  return async (headers) => {
    const session = await auth.api.getSession({ headers });
    return session?.user?.email ? { email: session.user.email } : null;
  };
}
