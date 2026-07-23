import { DurableObject } from 'cloudflare:workers';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import * as schema from './auth-schema.js';
import type { AuthProvider, AuthSubject } from './provider.js';

/**
 * The per-tenant IDENTITY Durable Object — one per tenant, running its OWN Better Auth
 * over its OWN SQLite (Drizzle's Durable-Object driver, not a shared D1), and holding the
 * provider-agnostic `sub → principal` directory. A tenant's users/sessions/credentials are
 * isolated in its DO; there is NO per-worker `AUTH_DB` to leak across tenants.
 *
 * It runs in its own isolate (separate process + storage from the vertical's business-data
 * DO), and is one of the vertical's OWN DO classes — a legal sandbox-clean binding (the
 * contract refuses only cross-script / platform bindings).
 *
 * Two roles, either or both used per deployment:
 *   - `doAuthProvider` (below) exposes Better Auth here as an `AuthProvider` (the
 *     `better-auth-do` config). With an OIDC provider instead, Better Auth stays dormant.
 *   - `setPendingOwner` / `resolvePrincipal` are the identity directory — used under EVERY
 *     provider, since the subject → principal mapping is provider-independent.
 */

const SCHEMA_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS user (
    id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
    email_verified INTEGER NOT NULL DEFAULT 0, image TEXT,
    created_at INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)),
    updated_at INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)))`,
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
  // each scope). Independent of WHICH provider verified the subject.
  `CREATE TABLE IF NOT EXISTS identity (scope_id TEXT NOT NULL, sub TEXT NOT NULL, principal TEXT NOT NULL, PRIMARY KEY (scope_id, sub))`,
  // The owner seat waiting to be claimed: set at provision, consumed by the first login.
  `CREATE TABLE IF NOT EXISTS pending_owner (scope_id TEXT PRIMARY KEY, principal TEXT NOT NULL)`,
];

export interface IdentityDoEnv {
  BETTER_AUTH_SECRET?: string;
}

export class IdentityDO extends DurableObject<IdentityDoEnv> {
  constructor(ctx: DurableObjectState, env: IdentityDoEnv) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      for (const stmt of SCHEMA_STATEMENTS) ctx.storage.sql.exec(stmt);
    });
  }

  /** Record the owner seat to be claimed by the first login into this scope (called at provision). */
  async setPendingOwner(scopeId: string, principal: string): Promise<void> {
    this.ctx.storage.sql.exec('INSERT OR REPLACE INTO pending_owner (scope_id, principal) VALUES (?, ?)', scopeId, principal);
  }

  /**
   * Map a verified subject to a PrincipalId in this scope. If already bound, return it. If
   * not, and the scope's owner seat is unclaimed, CLAIM it: bind this subject to the owner
   * principal and consume the pending seat. Otherwise null — a valid login with no seat has
   * no access. Provider-agnostic: the subject may come from Better Auth or an OIDC issuer.
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
      secret: this.env.BETTER_AUTH_SECRET ?? 'dev-only-secret-substrat-vertical-auth-32chars',
      baseURL: origin,
      trustedOrigins: [origin],
    });
  }

  /**
   * The DO's HTTP surface (used only when Better Auth is the chosen provider). `/__session`
   * resolves the request to an `AuthSubject`; everything else is a Better Auth request. The
   * worker forwards requests here; Better Auth never runs in the worker.
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

/** A minimal stub shape — the identity DO's callable surface (avoids leaking the full class type). */
export type IdentityStub = {
  fetch(request: Request): Promise<Response>;
  setPendingOwner(scopeId: string, principal: string): Promise<void>;
  resolvePrincipal(scopeId: string, sub: string): Promise<string | null>;
};

/**
 * The `AuthProvider` backed by a tenant's identity-DO stub (the `better-auth-do` config).
 * `handle` forwards the raw request; `resolve` asks the DO's `/__session` probe, carrying
 * the request's cookies. The worker holds only this — never Better Auth itself.
 */
export function doAuthProvider(stub: Pick<IdentityStub, 'fetch'>, origin: string): AuthProvider {
  return {
    handle: (request) => stub.fetch(request),
    async resolve(headers) {
      const res = await stub.fetch(new Request(`${origin}/__session`, { headers }));
      return (await res.json()) as AuthSubject | null;
    },
  };
}
