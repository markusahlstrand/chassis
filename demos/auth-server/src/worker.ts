/**
 * The auth-server demo as a Cloudflare Worker: a STANDALONE Better Auth OIDC provider.
 *
 * Unlike a Substrat vertical, this composes no kernel engines and has no ScopeDO — its whole
 * domain (users, sessions, OAuth clients, tokens, JWKS) is owned by Better Auth. The worker
 * is deliberately thin: it forwards the entire `/api/auth/*` surface to the single AuthServerDO
 * (which runs Better Auth), exposes a root-level OIDC discovery alias so any standard relying
 * party resolves `{issuer}/.well-known/openid-configuration`, runs a first-admin bootstrap,
 * and serves the inlined admin SPA. Admin authority is Better Auth's own `admin` role — the
 * dashboard signs in through this same issuer (it is its own first relying party).
 *
 * Local run:  wrangler dev
 */
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { AuthServerDO, type AuthServerStub } from './auth-do.js';
import { serveAsset } from './assets.js';

/** The single global issuer DO — one instance, addressed by a fixed name. */
export { AuthServerDO };

interface Env {
  AUTH: DurableObjectNamespace<AuthServerDO>;
  /** The canonical issuer origin; falls back to the request origin under local dev. */
  PUBLIC_ORIGIN?: string;
}

/** There is exactly one issuer, so one DO instance under a fixed name. */
function issuer(env: Env): AuthServerStub {
  return env.AUTH.get(env.AUTH.idFromName('auth-server')) as unknown as AuthServerStub;
}

const app = new Hono<{ Bindings: Env }>();

/**
 * Bootstrap state: is the issuer awaiting its first administrator? The SPA shows a
 * "create the first admin" screen instead of a sign-in when this is true.
 */
app.get('/api/setup-state', async (c) => c.json({ needsSetup: await issuer(c.env).needsSetup() }));

/**
 * Create the first administrator — allowed only while the issuer has zero users (the DO
 * enforces this fail-closed). After this, all account creation goes through the admin API,
 * which requires an existing admin.
 */
app.post('/api/setup', async (c) => {
  const body = await c.req.json<{ email?: string; password?: string; name?: string }>();
  if (!body.email || !body.password || !body.name) {
    throw new HTTPException(400, { message: 'email, password and name are required' });
  }
  if (body.password.length < 8) throw new HTTPException(400, { message: 'password must be at least 8 characters' });
  try {
    const { id } = await issuer(c.env).setupFirstAdmin(new URL(c.req.url).origin, {
      email: body.email,
      password: body.password,
      name: body.name,
    });
    return c.json({ ok: true, id }, 201);
  } catch (e) {
    throw new HTTPException(409, { message: e instanceof Error ? e.message : 'setup failed' });
  }
});

/** The verified subject + role behind the current session, or null (the SPA's session probe). */
app.get('/api/session', async (c) => {
  const res = await issuer(c.env).fetch(new Request(`${new URL(c.req.url).origin}/__session`, { headers: c.req.raw.headers }));
  return c.json(await res.json());
});

/**
 * OIDC discovery at the ROOT — the metadata's `issuer` is the clean origin, but Better Auth
 * serves the document under its base path (`/api/auth/.well-known/openid-configuration`). A
 * standard RP derives the discovery URL as `{issuer}/.well-known/openid-configuration`, so we
 * alias the root path to the Better-Auth one. The endpoints inside the doc all live under
 * `/api/auth/*`, which the catch-all below forwards. So an RP configured with
 * `OIDC_ISSUER = {origin}` (e.g. @substrat-run/oidc-rp) works with no rewriting.
 */
app.get('/.well-known/openid-configuration', async (c) => {
  const origin = new URL(c.req.url).origin;
  const res = await issuer(c.env).fetch(new Request(`${origin}/api/auth/.well-known/openid-configuration`, { headers: c.req.raw.headers }));
  return new Response(res.body, { status: res.status, headers: { 'content-type': 'application/json' } });
});

// The whole Better Auth surface — sign-in/up, password reset, the OIDC endpoints
// (authorize, token, userinfo, jwks, register, endsession), and the admin API — lives in the
// issuer DO. The worker only forwards; it never runs Better Auth itself. Better Auth's own
// admin endpoints enforce the `admin` role, so no extra gating is needed here.
app.on(['GET', 'POST', 'OPTIONS'], '/api/auth/*', (c) => issuer(c.env).fetch(c.req.raw));

// Serve the inlined admin SPA for everything else. MUST come last so the /api routes win.
app.all('*', (c) => serveAsset(new URL(c.req.url)));

app.onError((err, c) => {
  const status = err instanceof HTTPException ? err.status : 400;
  return c.json({ error: err instanceof Error ? err.message : String(err) }, status);
});

export default app;
