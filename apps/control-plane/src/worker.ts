/**
 * The shared control plane as a deployable Cloudflare Worker — now the whole
 * **portal**: it serves the console SPA, the audited control-plane API, and staff
 * sign-in (Better Auth on D1), all from one origin (first-flow.md slices 1 + 3).
 *
 * Routing (per request; the coordinator is stateless):
 *   - `/api/auth/*` → Better Auth (staff identity/sessions in D1)
 *   - `/api/*`      → the control-plane router, behind `sessionPlatformAuth` — a
 *                     request with no rostered staff session is refused
 *   - everything else → the console SPA (assets binding, SPA fallback)
 *
 * The module-less `ScopeDO` is bound only because `CloudflareScopeHost.provisionScope`
 * instantiates one (host.ts) — nothing domain-shaped runs here; the real scope DOs
 * live in the vertical's deployment.
 *
 * Deploy: `pnpm --filter @substrat-run/control-plane deploy` (builds the console,
 * then `wrangler deploy`; needs Workers Paid for DO SQLite + a D1 for staff auth).
 */
import { Hono } from 'hono';
import { platformActorId } from '@substrat-run/contracts';
import {
  CloudflareScopeHost,
  ControlPlaneDO,
  defineScopeDO,
} from '@substrat-run/adapter-cloudflare';
import {
  createControlPlaneApi,
  firstPlatformActorAuth,
  serviceTokenAuth,
  sessionPlatformAuth,
  staffAllowlist,
  UNSAFE_devPlatformActorAuth,
  type PlatformActorAuth,
} from '@substrat-run/control-plane-api';
import { buildStaffAuth, staffSessionReader } from './staff-auth.js';

/** The placeholder scope-DO class: kernel only, no modules. */
export const ScopeDO = defineScopeDO([], {});
export { ControlPlaneDO };

interface Env {
  SCOPE: DurableObjectNamespace;
  CONTROL_PLANE: DurableObjectNamespace;
  /** Better Auth's staff store. Absent in the workerd test (dev-actor path only). */
  AUTH_DB?: D1Database;
  /** The console SPA. Absent in the workerd test. */
  ASSETS?: Fetcher;
  BETTER_AUTH_SECRET?: string;
  BASE_URL?: string;
  /** Comma-separated staff emails allowed to act. Defaults to markus@substrat.run. */
  STAFF_EMAILS?: string;
  /** Shared secret a connected vertical presents (x-service-token) to register. */
  SERVICE_TOKEN?: string;
  /** Local dev / test only: trust the `x-platform-actor` header. NEVER on a real deploy. */
  ALLOW_DEV_ACTOR?: string;
}

// A fixed staff actor id for the audit log in this demo deployment. A real
// deployment would mint one per operator and map emails to their own ids.
const STAFF_ACTOR = platformActorId.parse('01JZ00000000000000000000MK');
// The actor a connected vertical acts as when it registers (a service, not staff).
const SERVICE_ACTOR = platformActorId.parse('01JZ00000000000000000000SV');

/** The coordinator is stateless — rebuilt per request; durable state is in the DOs. */
function hostFor(env: Env): CloudflareScopeHost {
  return new CloudflareScopeHost({ scope: env.SCOPE, controlPlane: env.CONTROL_PLANE });
}

/**
 * Staff session (Better Auth) when a D1 is bound, plus the UNSAFE dev-actor
 * header when explicitly enabled (local/test only). Session first; neither → 401.
 * Secure by default: a real deploy binds AUTH_DB and never sets ALLOW_DEV_ACTOR.
 */
function authFor(env: Env, origin: string): PlatformActorAuth {
  const readers: PlatformActorAuth[] = [];
  // Staff sign in (Better Auth session).
  if (env.AUTH_DB) {
    const auth = buildStaffAuth(env as { AUTH_DB: D1Database }, origin);
    const emails = (env.STAFF_EMAILS ?? 'markus@substrat.run')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    readers.push(
      sessionPlatformAuth(
        staffSessionReader(auth),
        staffAllowlist(emails.map((email) => ({ email, actor: STAFF_ACTOR }))),
      ),
    );
  }
  // A connected vertical registers as a service (shared token), not staff.
  if (env.SERVICE_TOKEN) readers.push(serviceTokenAuth(env.SERVICE_TOKEN, SERVICE_ACTOR));
  // Local dev / test only.
  if (env.ALLOW_DEV_ACTOR === 'true') readers.push(UNSAFE_devPlatformActorAuth());
  return firstPlatformActorAuth(...readers);
}

const originOf = (req: Request): string => new URL(req.url).origin;

export default {
  fetch(request: Request, env: Env): Response | Promise<Response> {
    const origin = originOf(request);
    const app = new Hono<{ Bindings: Env }>();

    // Better Auth owns /api/auth/* (only when a staff store is bound). Same-origin
    // with the console, so Better Auth's default basePath (/api/auth) matches.
    if (env.AUTH_DB) {
      app.on(['GET', 'POST'], '/api/auth/*', (c) =>
        buildStaffAuth(env as { AUTH_DB: D1Database }, origin).handler(c.req.raw),
      );
    }

    // The audited control-plane API under /api (the console's baseUrl).
    app.route('/api', createControlPlaneApi({ host: hostFor(env), authenticate: authFor(env, origin) }));

    // The console SPA for everything else; the assets binding does the SPA fallback.
    if (env.ASSETS) {
      const assets = env.ASSETS;
      app.all('*', () => assets.fetch(request));
    }

    return app.fetch(request, env);
  },
};
