import { betterAuth } from 'better-auth';
import type { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { oidcProvider, type Client } from 'better-auth/plugins/oidc-provider';
import { jwt } from 'better-auth/plugins/jwt';
import { admin } from 'better-auth/plugins/admin';
import type { EmailAddress, EmailTransport } from '@substrat-run/adapter-email';
import { resetPasswordEmail, verifyEmail } from './email.js';

/**
 * The Better Auth instance that IS this standalone OIDC provider. Runtime-agnostic: the
 * caller supplies the database (a `drizzleAdapter` over a Durable Object's SQLite in the
 * worker, or over better-sqlite3 in the Node dev server) and the email transport, so this
 * one config is the single source of truth for how the issuer behaves in every runtime.
 *
 * Plugins, in order:
 *   - `jwt`          — asymmetric signing keys (JWKS at `/api/auth/jwks`); id_tokens are
 *                      verifiable by any relying party from the public key, never a shared
 *                      secret. This is what makes the issuer consumable by external apps.
 *   - `oidcProvider` — the OIDC surface: discovery, `/authorize`, `/token`, `/userinfo`,
 *                      consent, and the client registry. Depends on `jwt` for id_token
 *                      signing, so it comes after it.
 *   - `admin`        — user management API (list/create/ban/role/impersonate) + the `admin`
 *                      role the dashboard gates on. The dashboard signs in HERE (the issuer
 *                      is its own first relying party) and is admin-gated by this role.
 */

/** The database argument Better Auth's drizzle adapter accepts — kept structural so this
 *  module imports no runtime-specific (node-only) drizzle driver types. */
export type AuthDatabase = ReturnType<typeof drizzleAdapter>;

export interface AuthDeps {
  /** `drizzleAdapter(db, { provider: 'sqlite', schema })` — built by the caller. */
  database: AuthDatabase;
  /** The session-signing / private-key-encryption secret (per-instance, persisted). */
  secret: string;
  /** The canonical issuer origin — Better Auth's baseURL; discovery/token URLs derive from it. */
  baseURL: string;
  /** Origins allowed to drive sign-in (the app itself, plus any first-party surface). */
  trustedOrigins: string[];
  /** The resolved email transport (Cloudflare in prod, mock in dev/tests). */
  transport: EmailTransport;
  /** The sender address for password-reset / verification mail. */
  sender: EmailAddress;
}

/**
 * A pre-registered relying party for the demo, so the OIDC round-trip is exercisable out of
 * the box (the scenario test drives authorize → token against it). `skipConsent` because a
 * trusted first-party client needs no consent screen. External apps register themselves via
 * the dynamic-registration endpoint or the admin dashboard — this is only the demo seed.
 */
export const DEMO_CLIENT: Client = {
  clientId: 'substrat-demo-rp',
  clientSecret: 'demo-rp-secret-not-for-production',
  name: 'Substrat Demo RP',
  type: 'web',
  redirectUrls: ['http://localhost:5279/callback'],
  disabled: false,
  metadata: null,
  skipConsent: true,
};

export function buildAuth(deps: AuthDeps) {
  return betterAuth({
    database: deps.database,
    emailAndPassword: {
      enabled: true,
      autoSignIn: true,
      minPasswordLength: 8,
      // The primary ask: password reset via the email adapter. Better Auth builds the
      // one-time reset URL; we wrap it in the transactional template and send it.
      sendResetPassword: async ({ user, url }) => {
        await deps.transport.send(resetPasswordEmail({ to: user.email, from: deps.sender, url }));
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      // Verification is offered (mail goes out through the same adapter) but not required to
      // sign in — this is a demo, not a compliance gate. Flip `requireEmailVerification` on
      // in emailAndPassword to make it mandatory.
      sendVerificationEmail: async ({ user, url }) => {
        await deps.transport.send(verifyEmail({ to: user.email, from: deps.sender, url }));
      },
    },
    plugins: [
      jwt(),
      oidcProvider({
        loginPage: '/login',
        consentPage: '/consent',
        // Sign id_tokens with the `jwt` plugin's ASYMMETRIC keys (RS256/EdDSA) and advertise
        // them in discovery — without this, Better Auth falls back to HS256 (a shared secret),
        // which no third-party RP could verify. This is what makes the issuer externally
        // consumable from the public JWKS alone.
        useJWTPlugin: true,
        // Let any OIDC-compatible app register itself as a relying party (the "standalone
        // auth server for whatever app" goal). Turn this off to lock the issuer down to
        // clients an admin registers by hand.
        allowDynamicClientRegistration: true,
        trustedClients: [DEMO_CLIENT],
      }),
      admin(),
    ],
    secret: deps.secret,
    baseURL: deps.baseURL,
    trustedOrigins: deps.trustedOrigins,
  });
}

export type Auth = ReturnType<typeof buildAuth>;
