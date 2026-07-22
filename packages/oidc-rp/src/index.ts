/**
 * The Substrat platform's OpenID Connect **relying party** — shared by the
 * platform apps (console, dashboard) so the security-critical verifier is written
 * once, not copied per app.
 *
 * It authenticates against the platform's AuthHero instance (the Auth0-compatible
 * OIDC authority). The kernel keeps authorization (roles/grants/tenancy); this
 * package only proves *who* the caller is — the ID token `sub` (and `email`).
 *
 * Standard Authorization-Code + PKCE, discovery-driven so nothing but the issuer
 * URL is wired in: endpoints and signing keys come from
 * `{issuer}/.well-known/openid-configuration`. Confidential client (server-side
 * code exchange with the client secret), and the ID token is signature-verified
 * against the issuer JWKS.
 *
 * Stateless: no KV, no D1. The short-lived PKCE/state/nonce rides a signed "flow"
 * cookie; the session is a signed JWT cookie. Both are HMAC-signed with
 * `SESSION_SECRET`. workerd-safe — Web Crypto + `jose` only, no `node:*`.
 *
 * Config is entirely runtime (secrets), never checked in:
 *   OIDC_ISSUER · OIDC_CLIENT_ID · OIDC_CLIENT_SECRET · SESSION_SECRET
 */
import { SignJWT, jwtVerify, createRemoteJWKSet } from 'jose';
import type { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';

export interface OidcEnv {
  /** The AuthHero issuer, e.g. https://auth.substrat.run — the only wired-in value. */
  OIDC_ISSUER: string;
  OIDC_CLIENT_ID: string;
  /** Secret (wrangler secret put OIDC_CLIENT_SECRET). */
  OIDC_CLIENT_SECRET: string;
  /** Secret (wrangler secret put SESSION_SECRET) — signs the flow + session cookies. */
  SESSION_SECRET: string;
  /** If set, the redirect origin is forced to this (else derived from the request). */
  BASE_URL?: string;
}

export interface SessionUser {
  id: string;
  email?: string;
  name?: string;
}

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  end_session_endpoint?: string;
}

export const SESSION_COOKIE = 'sb_session';
export const FLOW_COOKIE = 'sb_oidc_flow';
/** Session lifetime; the flow (login round-trip) is deliberately short. */
export const SESSION_MAXAGE = 60 * 60 * 24 * 7; // 7 days
export const FLOW_MAXAGE = 60 * 10; // 10 minutes

const enc = new TextEncoder();

const b64url = (bytes: ArrayBuffer | Uint8Array): string => {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const byte of b) s += String.fromCharCode(byte);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const randomB64url = (n = 32): string => b64url(crypto.getRandomValues(new Uint8Array(n)));

async function pkceChallenge(verifier: string): Promise<string> {
  return b64url(await crypto.subtle.digest('SHA-256', enc.encode(verifier)));
}

// Discovery + JWKS, cached per issuer for the life of the isolate.
const discoveryCache = new Map<string, Promise<Discovery>>();
function discover(issuer: string): Promise<Discovery> {
  const key = issuer.replace(/\/$/, '');
  let p = discoveryCache.get(key);
  if (!p) {
    const url = `${key}/.well-known/openid-configuration`;
    p = fetch(url).then(async (r) => {
      if (!r.ok) throw new Error(`OIDC discovery failed (${r.status}) at ${url}`);
      return (await r.json()) as Discovery;
    });
    discoveryCache.set(key, p);
  }
  return p;
}

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
function jwksFor(d: Discovery): ReturnType<typeof createRemoteJWKSet> {
  let j = jwksCache.get(d.jwks_uri);
  if (!j) {
    j = createRemoteJWKSet(new URL(d.jwks_uri));
    jwksCache.set(d.jwks_uri, j);
  }
  return j;
}

const signingKey = (env: OidcEnv): Uint8Array => enc.encode(env.SESSION_SECRET);
const redirectUri = (env: OidcEnv, origin: string): string =>
  `${(env.BASE_URL ?? origin).replace(/\/$/, '')}/api/auth/callback`;

/**
 * Begin login: the authorize-endpoint URL to redirect to, and the signed flow
 * cookie value that carries PKCE verifier + state + nonce across the round-trip.
 */
export async function beginLogin(
  env: OidcEnv,
  origin: string,
): Promise<{ location: string; flow: string }> {
  const d = await discover(env.OIDC_ISSUER);
  const verifier = randomB64url(32);
  const state = randomB64url(16);
  const nonce = randomB64url(16);
  const flow = await new SignJWT({ v: verifier, s: state, n: nonce })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${FLOW_MAXAGE}s`)
    .sign(signingKey(env));

  const u = new URL(d.authorization_endpoint);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', env.OIDC_CLIENT_ID);
  u.searchParams.set('redirect_uri', redirectUri(env, origin));
  u.searchParams.set('scope', 'openid email profile');
  u.searchParams.set('state', state);
  u.searchParams.set('nonce', nonce);
  u.searchParams.set('code_challenge', await pkceChallenge(verifier));
  u.searchParams.set('code_challenge_method', 'S256');
  return { location: u.toString(), flow };
}

/**
 * Complete login: verify state against the flow cookie, exchange the code for
 * tokens, verify the ID token (signature via JWKS, plus issuer/audience/nonce),
 * and return the user + a signed session cookie value.
 */
export async function completeLogin(
  env: OidcEnv,
  origin: string,
  url: URL,
  flowCookie: string | undefined,
): Promise<{ user: SessionUser; session: string }> {
  const oauthError = url.searchParams.get('error');
  if (oauthError) throw new Error(`authorization error: ${oauthError}`);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) throw new Error('missing code or state');
  if (!flowCookie) throw new Error('missing login flow cookie');

  let flow: { v: string; s: string; n: string };
  try {
    flow = (await jwtVerify(flowCookie, signingKey(env))).payload as unknown as typeof flow;
  } catch {
    throw new Error('invalid or expired login flow');
  }
  if (flow.s !== state) throw new Error('state mismatch');

  const d = await discover(env.OIDC_ISSUER);
  const res = await fetch(d.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(env, origin),
      client_id: env.OIDC_CLIENT_ID,
      client_secret: env.OIDC_CLIENT_SECRET,
      code_verifier: flow.v,
    }),
  });
  if (!res.ok) throw new Error(`token exchange failed (${res.status})`);
  const tokens = (await res.json()) as { id_token?: string };
  if (!tokens.id_token) throw new Error('no id_token in token response');

  const { payload } = await jwtVerify(tokens.id_token, jwksFor(d), {
    issuer: d.issuer,
    audience: env.OIDC_CLIENT_ID,
  });
  if (payload.nonce !== flow.n) throw new Error('nonce mismatch');

  const user = userFromClaims(payload);
  const session = await new SignJWT({ email: user.email, name: user.name })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAXAGE}s`)
    .sign(signingKey(env));
  return { user, session };
}

function userFromClaims(payload: { sub?: unknown; email?: unknown; name?: unknown }): SessionUser {
  return {
    id: String(payload.sub),
    email: typeof payload.email === 'string' ? payload.email : undefined,
    name: typeof payload.name === 'string' ? payload.name : undefined,
  };
}

/** Verify the session cookie value. `null` for no/invalid/expired session. */
export async function verifySession(
  env: OidcEnv,
  token: string | undefined,
): Promise<SessionUser | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, signingKey(env));
    if (!payload.sub) return null;
    return userFromClaims(payload);
  } catch {
    return null;
  }
}

/** Read one cookie value out of a raw `Cookie` header. */
export function readCookie(cookieHeader: string | null | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

/** Convenience: the session behind a request's `Cookie` header (framework-agnostic). */
export function sessionFromHeaders(env: OidcEnv, headers: Headers): Promise<SessionUser | null> {
  return verifySession(env, readCookie(headers.get('cookie'), SESSION_COOKIE));
}

const cookieOpts = (origin: string, maxAge: number) => ({
  httpOnly: true,
  secure: origin.startsWith('https:'),
  sameSite: 'Lax' as const,
  path: '/',
  maxAge,
});

export interface MountOptions {
  /** Where to send the browser after a successful login (default '/'). */
  onSuccess?: string;
  /** Where to send after a failed login (default '/?error=auth'). */
  onError?: string;
}

/**
 * Mount `/api/auth/login`, `/api/auth/callback`, `/api/auth/logout` on a Hono app.
 * Both platform apps wire the routes identically — cookie flags, redirects and the
 * PKCE round-trip — so the only per-app difference is what happens *after* the
 * session exists (JIT tenant bootstrap vs. staff-roster lookup), which stays in the
 * app.
 */
export function mountOidcRoutes<B extends OidcEnv>(app: Hono<{ Bindings: B }>, opts: MountOptions = {}): void {
  const onSuccess = opts.onSuccess ?? '/';
  const onError = opts.onError ?? '/?error=auth';

  app.get('/api/auth/login', async (c) => {
    const origin = new URL(c.req.url).origin;
    const { location, flow } = await beginLogin(c.env, origin);
    setCookie(c, FLOW_COOKIE, flow, cookieOpts(origin, FLOW_MAXAGE));
    return c.redirect(location);
  });

  app.get('/api/auth/callback', async (c) => {
    const origin = new URL(c.req.url).origin;
    const flow = getCookie(c, FLOW_COOKIE);
    deleteCookie(c, FLOW_COOKIE, { path: '/' });
    try {
      const { session } = await completeLogin(c.env, origin, new URL(c.req.url), flow);
      setCookie(c, SESSION_COOKIE, session, cookieOpts(origin, SESSION_MAXAGE));
      return c.redirect(onSuccess);
    } catch (err) {
      // Never swallow silently: a failing login round-trip is undiagnosable in prod
      // otherwise. The reason (token-exchange status, state/nonce mismatch, JWKS
      // verify) goes to Workers Logs; the browser still gets the opaque onError
      // redirect so nothing leaks to the caller.
      console.error('oidc.callback.failed', { reason: err instanceof Error ? err.message : String(err) });
      return c.redirect(onError);
    }
  });

  app.get('/api/auth/logout', (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.redirect(onSuccess);
  });
}
