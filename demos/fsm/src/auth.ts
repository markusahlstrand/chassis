import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from './auth-schema.js';

/**
 * Better Auth as the fsm demo's edge authentication adapter — the "second
 * adapter" behind the neutral kernel identity seam (D-16), running on the real
 * Cloudflare runtime (workerd). It owns identity, credentials and sessions in
 * its OWN store — a Cloudflare D1 database (`AUTH_DB`) via Drizzle's first-class
 * `drizzle-orm/d1` driver — entirely separate from the scope-host Durable
 * Objects and the control-plane directory. Authentication only: the kernel keeps
 * authorization (roles/grants/tenancy), so Better Auth's organization/RBAC
 * plugins stay off by design.
 *
 * workerd-safe: no `node:*`, no `better-sqlite3`. The same seam the shop demo
 * runs on Node runs here on the edge. OIDC/social/SSO are later config on THIS
 * same adapter, needing no kernel change — the point of doing the seam neutrally.
 *
 * The instance is rebuilt per request: the coordinator is stateless (durable
 * state lives in D1 and the DOs), matching how `hostFor` rebuilds the host.
 */
export interface AuthEnv {
  AUTH_DB: D1Database;
  BETTER_AUTH_SECRET?: string;
  BASE_URL?: string;
}

export function buildAuth(env: AuthEnv) {
  const baseURL = env.BASE_URL ?? 'http://localhost:8799';
  const db = drizzle(env.AUTH_DB, { schema });
  return betterAuth({
    database: drizzleAdapter(db, { provider: 'sqlite', schema }),
    emailAndPassword: { enabled: true, autoSignIn: true, minPasswordLength: 8 },
    secret: env.BETTER_AUTH_SECRET ?? 'dev-only-secret-substrat-fsm-demo-32chars',
    baseURL,
    trustedOrigins: [baseURL, 'http://localhost:8799'],
  });
}

/** The concrete Better Auth instance type (kept precise for the adapter to consume). */
export type Auth = ReturnType<typeof buildAuth>;
