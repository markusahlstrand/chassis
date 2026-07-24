import { DurableObject } from 'cloudflare:workers';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { resolveEnvSpec } from '@substrat-run/contracts';
import { schema } from './auth-schema.js';
import { SCHEMA_STATEMENTS } from '../db/ddl.js';
import { buildAuth } from './auth.js';
import { transportFor, senderFor } from './email.js';
import { AUTH_SERVER_ENV } from './manifest.js';

/**
 * The single global issuer, as one Durable Object. There is exactly one instance (the
 * worker addresses it by a fixed name), and it owns the ENTIRE identity store — users,
 * sessions, OAuth clients, access tokens, consent, and the JWKS signing keys — in its own
 * SQLite. Its Better Auth signing secret is generated here on first init and persisted in
 * its own `config` table, so there is no shared `wrangler secret` to set.
 *
 * The worker never runs Better Auth; it forwards the `/api/auth/*` surface here. `fetch`
 * runs Better Auth's handler for everything except the small `/__*` control probes.
 */

export interface AuthServerDoEnv {
  /** The Cloudflare Email Service `send_email` binding (password-reset / verification mail). */
  EMAIL?: import('@substrat-run/adapter-email').SendEmailBinding;
  /** The sender address; its domain must be onboarded for sending. */
  EMAIL_FROM?: string;
  /** The canonical issuer origin (e.g. https://auth.substrat.run). Falls back to the request origin. */
  PUBLIC_ORIGIN?: string;
  /** Bootstrap admin address — when set with ADMIN_PASSWORD, seeded as `admin` on first init. */
  ADMIN_EMAIL?: string;
  /** Bootstrap admin password (a secret). Seeds the first admin deterministically, no setup race. */
  ADMIN_PASSWORD?: string;
}

export class AuthServerDO extends DurableObject<AuthServerDoEnv> {
  /** This issuer's Better Auth signing secret — generated in this DO, never a worker binding. */
  private authSecret!: string;
  /** The declared config (manifest env-spec) resolved against this DO's env — the single
   *  source of which keys the issuer reads (PUBLIC_ORIGIN, ADMIN_EMAIL/PASSWORD, EMAIL_FROM). */
  private readonly cfg: Record<string, string | undefined>;

  constructor(ctx: DurableObjectState, env: AuthServerDoEnv) {
    super(ctx, env);
    this.cfg = resolveEnvSpec(AUTH_SERVER_ENV, env as Record<string, unknown>).values;
    ctx.blockConcurrencyWhile(async () => {
      for (const stmt of SCHEMA_STATEMENTS) ctx.storage.sql.exec(stmt);
      const row = [...ctx.storage.sql.exec("SELECT value FROM config WHERE key = 'auth_secret'")][0] as
        | { value: string }
        | undefined;
      if (row) {
        this.authSecret = row.value;
      } else {
        const bytes = crypto.getRandomValues(new Uint8Array(32));
        this.authSecret = btoa(String.fromCharCode(...bytes));
        ctx.storage.sql.exec("INSERT INTO config (key, value) VALUES ('auth_secret', ?)", this.authSecret);
      }
      await this.seedEnvAdmin();
    });
  }

  /**
   * Deterministic bootstrap: if `ADMIN_EMAIL` + `ADMIN_PASSWORD` are configured (worker
   * secrets, which a DO reads off `this.env` like any binding) and the issuer has no users
   * yet, create that admin on first init. This removes the "first user to sign in wins" race
   * of the setup screen — the operator owns the credentials up front. Runs once (guarded on a
   * zero-user store), never overwrites an existing admin, and never crashes the DO on failure.
   * When these are unset, the setup screen remains the fallback.
   */
  private async seedEnvAdmin(): Promise<void> {
    const email = this.cfg.ADMIN_EMAIL?.trim();
    const password = this.cfg.ADMIN_PASSWORD;
    if (!email || !password) return;
    const count = ([...this.ctx.storage.sql.exec('SELECT count(*) AS n FROM user')][0] as { n: number }).n;
    if (count > 0) return;
    if (password.length < 8) {
      console.warn('auth-server: ADMIN_PASSWORD is shorter than 8 characters — skipping env admin seed');
      return;
    }
    try {
      // Password hashing is origin-independent, so the boot-time baseURL fallback is fine.
      const auth = this.auth(this.cfg.PUBLIC_ORIGIN ?? 'http://localhost');
      const created = await auth.api.signUpEmail({ body: { email, password, name: 'Administrator' } });
      this.ctx.storage.sql.exec("UPDATE user SET role = 'admin', email_verified = 1 WHERE id = ?", created.user.id);
    } catch (e) {
      console.error('auth-server: env admin seed failed', e);
    }
  }

  /** A Better Auth instance over THIS DO's SQLite, issuing for `origin`. */
  private auth(origin: string) {
    const baseURL = this.cfg.PUBLIC_ORIGIN ?? origin;
    const db = drizzle(this.ctx.storage, { schema });
    return buildAuth({
      database: drizzleAdapter(db, { provider: 'sqlite', schema }),
      secret: this.authSecret,
      baseURL,
      // Both the canonical origin and the actual request origin are trusted, so local
      // `wrangler dev` (no PUBLIC_ORIGIN) and a real deploy both work.
      trustedOrigins: [...new Set([baseURL, origin])],
      // EMAIL is a Cloudflare binding (infra, not a declared string key), so it's read from
      // env directly; the sender address is the manifest-declared EMAIL_FROM.
      transport: transportFor(this.env),
      sender: senderFor(this.cfg.EMAIL_FROM),
    });
  }

  /** Is the issuer un-bootstrapped (no users yet)? The worker shows "create the first admin". */
  async needsSetup(): Promise<boolean> {
    const row = [...this.ctx.storage.sql.exec('SELECT count(*) AS n FROM user')][0] as { n: number };
    return row.n === 0;
  }

  /**
   * Bootstrap the first administrator — the only account creation that needs no existing
   * admin. Allowed ONLY while the issuer has zero users (fail-closed against a second call
   * racing in). Creates the account through Better Auth, then promotes it to the `admin`
   * role and marks the address verified, so the operator can sign straight into the
   * dashboard. Returns the new user id.
   */
  async setupFirstAdmin(origin: string, creds: { email: string; password: string; name: string }): Promise<{ id: string }> {
    if (!(await this.needsSetup())) throw new Error('the auth server is already set up');
    const auth = this.auth(origin);
    const created = await auth.api.signUpEmail({
      body: { email: creds.email, password: creds.password, name: creds.name },
    });
    const id = created.user.id;
    this.ctx.storage.sql.exec("UPDATE user SET role = 'admin', email_verified = 1 WHERE id = ?", id);
    return { id };
  }

  /**
   * The DO's HTTP surface. `/__session` resolves the request to `{ sub, email, name, role }`
   * (or null); everything else is a Better Auth request — sign-in, the whole OIDC surface
   * (discovery, authorize, token, jwks, userinfo), and the admin API.
   */
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const auth = this.auth(url.origin);
    if (url.pathname === '/__session') {
      const session = await auth.api.getSession({ headers: request.headers });
      const u = session?.user as { id: string; email?: string; name?: string; role?: string } | undefined;
      return Response.json(
        u ? { sub: u.id, email: u.email ?? null, name: u.name ?? null, role: u.role ?? null } : null,
      );
    }
    return auth.handler(request);
  }
}

/** The DO's callable surface (avoids leaking the full class type through the binding). */
export type AuthServerStub = {
  fetch(request: Request): Promise<Response>;
  needsSetup(): Promise<boolean>;
  setupFirstAdmin(origin: string, creds: { email: string; password: string; name: string }): Promise<{ id: string }>;
};

/** The verified subject behind a session, as the `/__session` probe returns it. */
export interface SessionSubject {
  sub: string;
  email: string | null;
  name: string | null;
  role: string | null;
}
