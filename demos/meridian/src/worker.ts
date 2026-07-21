/**
 * Meridian (HR) vertical as a deployable Cloudflare Worker.
 *
 * The same vertical the node/SQLite `server.ts` runs, on the Durable-Object
 * adapter: one `ScopeDO` per scope (kernel + protocol engine + the Meridian
 * module bundled), a `ControlPlaneDO` directory, a thin Hono API, the Scrive
 * connector registered on the coordinator, and a `scheduled()` handler that runs
 * the platform sweep on a Cron — the timer the connector's poll path needs (#96),
 * which has no equivalent on the node `setInterval`.
 *
 * Local run:  wrangler dev            (real workerd, no account; ALLOW_DEV_HEADER)
 * Deploy:     wrangler deploy         (Workers Paid — DO SQLite)
 *
 * Auth here is the dev-header only (gated). Better Auth on D1 lands in a follow-up
 * (mirroring demos/callout/src/auth.ts) — this file is the runnable skeleton.
 */
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { principalId, scopeId, tenantId, platformActorId, z } from '@substrat-run/contracts';
import { defineScopeDO, ControlPlaneDO, CloudflareScopeHost } from '@substrat-run/adapter-cloudflare';
import {
  assertPlatformCall,
  PlatformCallError,
  readRoutedNode,
  RouterAssertionError,
  runPlatformSweep,
  webCryptoSecretBox,
  type FetchLike,
  type SecretBox,
} from '@substrat-run/kernel';
import {
  registerScriveConnector,
  sweepScriveReconciliations,
  SCRIVE_TESTBED,
} from '@substrat-run/connector-scrive';
import { MODULES, provisionMeridian, type ScriveCredential } from './provision.js';

/** The scope-DO class = the app binary: kernel + protocol + Meridian, bundled. */
export const ScopeDO = defineScopeDO(MODULES, {});
export { ControlPlaneDO };

/** The platform actor the worker acts as for provisioning + the scheduled sweep. */
const STAFF = platformActorId.parse('01JZ000000000000000000MER1');

interface Node {
  tenantId: ReturnType<typeof tenantId.parse>;
  scopeId: ReturnType<typeof scopeId.parse>;
}

interface Env {
  SCOPE: DurableObjectNamespace;
  CONTROL_PLANE: DurableObjectNamespace;
  /** Local dev only: when 'true', trust the `x-principal` header. NEVER in prod. */
  ALLOW_DEV_HEADER?: string;
  /** Shared secret the router presents (K-26); a request without it cannot assert a tenant. */
  ROUTER_SECRET?: string;
  /** Shared secret the control plane presents to provision here (K-31). Unset → provisioning refused. */
  PLATFORM_SECRET?: string;
  /** Serve one fixed demo node with no router in front (wrangler dev / single-tenant box). */
  STANDALONE?: string;
  DEMO_TENANT?: string;
  DEMO_SCOPE?: string;
  // --- Scrive (optional): the four OAuth1 creds + a base64 32-byte SecretBox key enable it ---
  SCRIVE_CLIENT_ID?: string;
  SCRIVE_CLIENT_SECRET?: string;
  SCRIVE_TOKEN_ID?: string;
  SCRIVE_TOKEN_SECRET?: string;
  SCRIVE_BASE_URL?: string;
  /** base64-encoded 32 bytes — seals connection credentials at rest (SecretBox). */
  CONNECTION_SECRET_KEY?: string;
}

/** base64 → bytes, web-standard (`atob` exists in workerd). */
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Scrive config from the environment, or null when not fully supplied. Requires
 * all four OAuth1 parts AND the SecretBox key — a credential cannot be stored
 * without a box to seal it, so partial config disables Scrive rather than
 * failing later.
 */
function scriveConfigFor(env: Env): { secret: ScriveCredential; secretBox: SecretBox; baseUrl: string } | null {
  const { SCRIVE_CLIENT_ID, SCRIVE_CLIENT_SECRET, SCRIVE_TOKEN_ID, SCRIVE_TOKEN_SECRET, CONNECTION_SECRET_KEY } = env;
  if (!(SCRIVE_CLIENT_ID && SCRIVE_CLIENT_SECRET && SCRIVE_TOKEN_ID && SCRIVE_TOKEN_SECRET && CONNECTION_SECRET_KEY)) {
    return null;
  }
  return {
    secret: {
      clientId: SCRIVE_CLIENT_ID,
      clientSecret: SCRIVE_CLIENT_SECRET,
      tokenId: SCRIVE_TOKEN_ID,
      tokenSecret: SCRIVE_TOKEN_SECRET,
    },
    secretBox: webCryptoSecretBox('meridian', base64ToBytes(CONNECTION_SECRET_KEY)),
    baseUrl: env.SCRIVE_BASE_URL ?? SCRIVE_TESTBED,
  };
}

/** The coordinator is stateless — rebuilt per request; durable state lives in the DOs. */
function hostFor(env: Env): CloudflareScopeHost {
  const scrive = scriveConfigFor(env);
  const host = new CloudflareScopeHost({
    scope: env.SCOPE,
    controlPlane: env.CONTROL_PLANE,
    // The box lives on the coordinator; the DO only ever holds ciphertext. Set
    // exactly when Scrive is configured (nothing else stores a credential here).
    ...(scrive ? { secretBox: scrive.secretBox } : {}),
  });
  for (const m of MODULES) host.registerModule(m);
  // The connector is host code, registered on the coordinator — but only when
  // Scrive is configured, since a registered connector with no connection would
  // fail every dispatch.
  if (scrive) registerScriveConnector(host, { baseUrl: scrive.baseUrl });
  return host;
}

/** Which tenant/scope this request is for: router-asserted, else the standalone demo node, else refuse. */
function nodeFor(req: Request, env: Env): Node {
  let routed;
  try {
    routed = readRoutedNode(req.headers, { expectedSecret: env.ROUTER_SECRET });
  } catch (e) {
    if (e instanceof RouterAssertionError) throw new HTTPException(400, { message: e.message });
    throw e;
  }
  if (routed) return { tenantId: routed.tenantId, scopeId: routed.scopeId };
  if (env.STANDALONE === 'true' && env.DEMO_TENANT && env.DEMO_SCOPE) {
    return { tenantId: tenantId.parse(env.DEMO_TENANT), scopeId: scopeId.parse(env.DEMO_SCOPE) };
  }
  throw new HTTPException(503, {
    message: 'no scope was asserted for this request (missing router, or set STANDALONE + DEMO_TENANT/DEMO_SCOPE)',
  });
}

/** Dev-header principal resolution (external-vertical pattern). Off unless ALLOW_DEV_HEADER=true. */
function devPrincipal(req: Request, env: Env): ReturnType<typeof principalId.parse> | null {
  if (env.ALLOW_DEV_HEADER !== 'true') return null;
  const raw = req.headers.get('x-principal');
  if (!raw) return null;
  const parsed = principalId.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

const provisionInstanceBody = z.object({
  tenantId,
  scopeId,
  owner: principalId,
  slug: z.string().min(1),
  name: z.string().min(1),
});

const app = new Hono<{ Bindings: Env }>();

/**
 * Provision ONE instance on the platform's instruction (K-31). Authenticated by
 * the platform secret alone — no principal, no scope, because at this moment
 * neither exists yet. NOT under /api/* (the tenant-facing surface). Idempotent.
 */
app.post('/internal/provision', async (c) => {
  try {
    assertPlatformCall(c.req.raw.headers, { expectedSecret: c.env.PLATFORM_SECRET });
  } catch (e) {
    if (e instanceof PlatformCallError) throw new HTTPException(403, { message: e.message });
    throw e;
  }
  const body = provisionInstanceBody.parse(await c.req.json());
  const scrive = scriveConfigFor(c.env);
  const instance = await provisionMeridian(hostFor(c.env), body, { scrive: scrive?.secret });
  return c.json(instance, 201);
});

/** Resolve the caller (dev-header) → the routed node → a scope stub. 401 if unresolved. */
async function stub(c: { env: Env; req: { raw: Request } }) {
  const node = nodeFor(c.req.raw, c.env);
  const principal = devPrincipal(c.req.raw, c.env);
  if (!principal) throw new HTTPException(401, { message: 'unauthorized' });
  return hostFor(c.env).getScope(principal, node.tenantId, node.scopeId);
}

app.get('/api/me', (c) => {
  const principal = devPrincipal(c.req.raw, c.env);
  if (!principal) return c.json({ error: 'unauthorized' }, 401);
  return c.json({ principal });
});

// Generic invoke: the kernel checks the permission inside every operation, so a
// generic route is exactly as safe as an explicit table — and far less code.
app.post('/api/invoke', async (c) => {
  const { op, input } = await c.req.json<{ op: string; input?: unknown }>();
  return c.json((await (await stub(c)).invoke(op, input)) ?? null);
});

app.onError((err, c) => {
  const status = err instanceof HTTPException ? err.status : 400;
  const m = err instanceof Error ? err.message : String(err);
  if (status === 400 && /permission denied/.test(m)) return c.json({ error: m }, 403);
  if (status === 400 && /not found|unknown scope/.test(m)) return c.json({ error: m }, 404);
  return c.json({ error: m }, status);
});

export default {
  fetch: app.fetch,

  /**
   * The Cron trigger (#96 poll path): one platform sweep per tick — drain every
   * active scope's due deliveries (the outbound connector dispatch and the
   * executor retry driver) and reconcile every live Scrive connection. This is
   * the timer the node runtime got from `setInterval` and Cloudflare gets here.
   */
  async scheduled(_event: unknown, env: Env): Promise<void> {
    const host = hostFor(env);
    const scrive = scriveConfigFor(env);
    const report = await runPlatformSweep(host, {
      actor: STAFF,
      fetch: (globalThis as unknown as { fetch: FetchLike }).fetch,
      sweepers: scrive ? { scrive: sweepScriveReconciliations } : {},
    });
    if (report.errors.length) console.error('[scheduled] sweep errors', report.errors);
  },
};
