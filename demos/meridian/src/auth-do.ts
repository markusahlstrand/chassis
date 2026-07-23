import { DurableObject } from 'cloudflare:workers';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import * as schema from './auth-schema.js';
import type { AuthProvider, AuthSubject } from './auth-provider.js';

/**
 * SPIKE — auth as a separate Durable Object, behind the `AuthProvider` contract.
 *
 * One `AuthDO` PER TENANT (keyed by tenant id in the worker), running its OWN Better Auth
 * instance over its OWN SQLite — via Drizzle's Durable-Object driver (`drizzle-orm/
 * durable-sqlite`), not a shared D1. So a tenant's users/sessions/credentials are isolated
 * in that tenant's DO, and there is NO per-worker `AUTH_DB` to leak across tenants. The
 * vertical worker never imports Better Auth on the request path — it holds a stub and
 * talks the contract (`doAuthProvider`), so the auth implementation is swappable.
 *
 * Runs in its own DO isolate: separate process + storage from the `ScopeDO` that holds the
 * business data. This is a legal sandbox-clean binding because `AuthDO` is one of the
 * vertical's OWN DO classes (not a cross-script binding, which the contract refuses).
 */

// Better Auth's tables, created in THIS DO's SQLite on first use (idempotent). Mirrors
// migrations/0001_better_auth.sql — inlined because a DO can't read a migrations dir.
const SCHEMA_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS user (
    id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
    email_verified INTEGER NOT NULL DEFAULT 0, image TEXT,
    created_at INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)),
    updated_at INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)),
    principal_id TEXT)`,
  `CREATE TABLE IF NOT EXISTS session (
    id TEXT PRIMARY KEY NOT NULL, expires_at INTEGER NOT NULL, token TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)),
    updated_at INTEGER NOT NULL, ip_address TEXT, user_agent TEXT,
    user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE)`,
  `CREATE INDEX IF NOT EXISTS session_userId_idx ON session (user_id)`,
  `CREATE TABLE IF NOT EXISTS account (
    id TEXT PRIMARY KEY NOT NULL, account_id TEXT NOT NULL, provider_id TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    access_token TEXT, refresh_token TEXT, id_token TEXT,
    access_token_expires_at INTEGER, refresh_token_expires_at INTEGER, scope TEXT, password TEXT,
    created_at INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)),
    updated_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS account_userId_idx ON account (user_id)`,
  `CREATE TABLE IF NOT EXISTS verification (
    id TEXT PRIMARY KEY NOT NULL, identifier TEXT NOT NULL, value TEXT NOT NULL, expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)),
    updated_at INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)))`,
  `CREATE INDEX IF NOT EXISTS verification_identifier_idx ON verification (identifier)`,
  // The PROVIDER-AGNOSTIC identity directory: a verified subject (`sub`) → the Substrat
  // PrincipalId it maps to, per scope (K-22 — the same login is a different principal in
  // each scope). Written when a login claims the instance; read on every request after.
  // Independent of WHICH provider verified the subject (Better Auth here, or an OIDC issuer).
  `CREATE TABLE IF NOT EXISTS identity (scope_id TEXT NOT NULL, sub TEXT NOT NULL, principal TEXT NOT NULL, PRIMARY KEY (scope_id, sub))`,
  // The owner seat waiting to be claimed: set at provision, consumed by the first login.
  `CREATE TABLE IF NOT EXISTS pending_owner (scope_id TEXT PRIMARY KEY, principal TEXT NOT NULL)`,
];

interface AuthDoEnv {
  BETTER_AUTH_SECRET?: string;
}

export class AuthDO extends DurableObject<AuthDoEnv> {
  constructor(ctx: DurableObjectState, env: AuthDoEnv) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      for (const stmt of SCHEMA_STATEMENTS) ctx.storage.sql.exec(stmt);
    });
  }

  /**
   * Record the owner seat to be claimed by the first login into this scope (called at
   * provision). Provider-agnostic — the subject that later claims it may come from Better
   * Auth or an OIDC issuer.
   */
  async setPendingOwner(scopeId: string, principal: string): Promise<void> {
    this.ctx.storage.sql.exec('INSERT OR REPLACE INTO pending_owner (scope_id, principal) VALUES (?, ?)', scopeId, principal);
  }

  /**
   * Map a verified subject to a PrincipalId in this scope. If already bound, return it. If
   * not, and the scope's owner seat is unclaimed, CLAIM it: bind this subject to the owner
   * principal (the installer becomes `hr-admin`) and consume the pending seat. Otherwise
   * return null — a stranger with a valid login but no seat has no access.
   */
  async resolvePrincipal(scopeId: string, sub: string): Promise<string | null> {
    const bound = [...this.ctx.storage.sql.exec('SELECT principal FROM identity WHERE scope_id = ? AND sub = ?', scopeId, sub)][0] as
      | { principal: string }
      | undefined;
    if (bound) return bound.principal;
    const pending = [...this.ctx.storage.sql.exec('SELECT principal FROM pending_owner WHERE scope_id = ?', scopeId)][0] as
      | { principal: string }
      | undefined;
    if (!pending) return null;
    this.ctx.storage.sql.exec('INSERT OR REPLACE INTO identity (scope_id, sub, principal) VALUES (?, ?, ?)', scopeId, sub, pending.principal);
    this.ctx.storage.sql.exec('DELETE FROM pending_owner WHERE scope_id = ?', scopeId);
    return pending.principal;
  }

  /** A Better Auth instance over THIS DO's SQLite, trusting the caller's origin. */
  private auth(origin: string) {
    const db = drizzle(this.ctx.storage, { schema });
    return betterAuth({
      database: drizzleAdapter(db, { provider: 'sqlite', schema }),
      emailAndPassword: { enabled: true, autoSignIn: true, minPasswordLength: 8 },
      secret: this.env.BETTER_AUTH_SECRET ?? 'dev-only-secret-substrat-meridian-demo-32chars',
      baseURL: origin,
      trustedOrigins: [origin],
    });
  }

  /**
   * The DO's HTTP surface. `/__session` resolves the request to an `AuthSubject` (the
   * contract's `resolve`); everything else is a Better Auth request (the contract's
   * `handle`). The worker forwards requests here; Better Auth never runs in the worker.
   */
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const auth = this.auth(url.origin);
    if (url.pathname === '/__session') {
      const session = await auth.api.getSession({ headers: request.headers });
      const subject: AuthSubject | null = session?.user
        ? { sub: session.user.id, email: session.user.email ?? null, name: session.user.name ?? null }
        : null;
      return Response.json(subject);
    }
    return auth.handler(request);
  }
}

/**
 * The `AuthProvider` backed by a tenant's `AuthDO` stub. `handle` forwards the raw request;
 * `resolve` asks the DO's `/__session` probe, carrying the request's cookies. The worker
 * holds only this — never Better Auth itself.
 */
export function doAuthProvider(stub: DurableObjectStub, origin: string): AuthProvider {
  return {
    handle: (request) => stub.fetch(request),
    async resolve(headers) {
      const res = await stub.fetch(new Request(`${origin}/__session`, { headers }));
      return (await res.json()) as AuthSubject | null;
    },
  };
}
