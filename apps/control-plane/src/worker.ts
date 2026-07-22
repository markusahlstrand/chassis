/**
 * The shared control plane as a deployable Cloudflare Worker — now the whole
 * **portal**: it serves the console SPA, the audited control-plane API, and staff
 * sign-in (OIDC against AuthHero), all from one origin (first-flow.md slices 1 + 3).
 *
 * Routing (per request; the coordinator is stateless):
 *   - `/api/auth/*` → the OIDC relying party (login/callback/logout) + `/session`
 *   - `/api/*`      → the control-plane router, behind `sessionPlatformAuth` — a
 *                     request with no rostered staff session is refused
 *   - everything else → the console SPA (assets binding, SPA fallback)
 *
 * The module-less `ScopeDO` is bound only because `CloudflareScopeHost.provisionScope`
 * instantiates one (host.ts) — nothing domain-shaped runs here; the real scope DOs
 * live in the vertical's deployment.
 *
 * Deploy: `pnpm --filter @substrat-run/control-plane deploy` (builds the console,
 * then `wrangler deploy`; needs Workers Paid for DO SQLite + a D1 for the roster).
 */
import { Hono } from 'hono';
import { platformActorId } from '@substrat-run/contracts';
import type { PlatformActorId } from '@substrat-run/contracts';
import {
  CloudflareScopeHost,
  ControlPlaneDO,
  defineScopeDO,
} from '@substrat-run/adapter-cloudflare';
import {
  createControlPlaneApi,
  createWfpUploader,
  firstPlatformActorAuth,
  serviceTokenAuth,
  sessionPlatformAuth,
  UNSAFE_devPlatformActorAuth,
  type DeployVerticalFn,
  type PlatformActorAuth,
} from '@substrat-run/control-plane-api';
import { VerticalClient } from '@substrat-run/control-plane-api';
import { mountOidcRoutes, type OidcEnv } from '@substrat-run/oidc-rp';
import { oidcStaffSessionReader } from './staff-auth.js';
import { d1StaffRoster } from './staff-roster.js';

/** The placeholder scope-DO class: kernel only, no modules. */
export const ScopeDO = defineScopeDO([], {});
export { ControlPlaneDO };

interface Env extends OidcEnv {
  SCOPE: DurableObjectNamespace;
  CONTROL_PLANE: DurableObjectNamespace;
  /** The staff roster's D1 store (#42). Absent in the workerd test (dev-actor path only). */
  AUTH_DB?: D1Database;
  /** The console SPA. Absent in the workerd test. */
  ASSETS?: Fetcher;
  /** Shared secret a connected vertical presents (x-service-token) to register. */
  SERVICE_TOKEN?: string;
  /** Local dev / test only: trust the `x-platform-actor` header. NEVER on a real deploy. */
  ALLOW_DEV_ACTOR?: string;
  /**
   * Shared secret presented to a vertical when provisioning an instance (K-31).
   * Must match that vertical's own `PLATFORM_SECRET`. Unset means instance creation
   * is unavailable, and the route says so rather than failing obscurely.
   */
  PLATFORM_SECRET?: string;
  /**
   * A `substrat push` uploads a built vertical bundle into this WfP dispatch namespace,
   * with the platform's own token — the builder never holds one (D-34, self-serve-deploy.md).
   * All three unset ⇒ the deploy route 501s.
   */
  CF_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  DISPATCH_NAMESPACE?: string;
  /**
   * The WfP dispatch namespace holding pushed verticals — the control plane reaches one
   * to provision an instance of it (orchestration.md §5.4), the mirror of the router.
   */
  DISPATCH?: DispatchNamespace;
  /**
   * Service bindings to vertical deployments, `VERTICAL_<SLUG>` with dashes as
   * underscores — the same convention and the same static-map shape the router
   * carries, with the same Workers-for-Platforms swap later.
   */
  [binding: string]: unknown;
}

/** Minimal shape of a WfP dispatch namespace binding. */
interface DispatchNamespace {
  get(name: string): Fetcher;
}

/** The WfP uploader, when the platform's CF credential is configured (self-serve-deploy.md). */
function deployVerticalFor(env: Env): DeployVerticalFn | undefined {
  if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID) return undefined;
  return createWfpUploader({
    accountId: env.CF_ACCOUNT_ID,
    namespace: env.DISPATCH_NAMESPACE ?? 'substrat-verticals',
    apiToken: env.CF_API_TOKEN,
  });
}

/**
 * Resolve a pushed vertical for provisioning: slug → its `prod` channel version →
 * `env.DISPATCH.get(deploymentRef)` (orchestration.md §5.4). The mirror of the router's
 * verticalFor. Absent DISPATCH or PLATFORM_SECRET ⇒ only static VERTICAL_ bindings work.
 */
function resolveVerticalFor(
  env: Env,
): ((slug: string, actor: PlatformActorId) => Promise<VerticalClient | undefined>) | undefined {
  const dispatch = env.DISPATCH;
  const secret = env.PLATFORM_SECRET;
  if (!dispatch || !secret) return undefined;
  return async (slug, actor) => {
    const host = hostFor(env);
    const prod = (await host.admin.listChannels(actor, slug)).find((c) => c.channel === 'prod');
    if (!prod) return undefined;
    const version = (await host.admin.listVersions(actor, slug)).find((v) => v.id === prod.versionId);
    if (!version?.deploymentRef) return undefined;
    const fetcher = dispatch.get(version.deploymentRef);
    return new VerticalClient({ fetch: fetcher.fetch.bind(fetcher), platformSecret: secret });
  };
}

// The actor a connected vertical acts as when it registers (a service, not staff).
const SERVICE_ACTOR = platformActorId.parse('01JZ00000000000000000000SV');

/**
 * The verticals this control plane can provision into (K-31).
 *
 * Discovered from the bindings rather than listed in code, so adding a vertical is a
 * wrangler change and not a code change. Empty without `PLATFORM_SECRET`: a vertical
 * refuses an unauthenticated provisioning call anyway, and an empty map makes the
 * route answer "no deployment bound" instead of failing at the far end.
 */
function verticalsFor(env: Env): Record<string, VerticalClient> {
  const secret = env.PLATFORM_SECRET;
  if (!secret) return {};
  const out: Record<string, VerticalClient> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith('VERTICAL_')) continue;
    const binding = value as { fetch?: typeof fetch };
    if (typeof binding?.fetch !== 'function') continue;
    const slug = key.slice('VERTICAL_'.length).toLowerCase().replace(/_/g, '-');
    out[slug] = new VerticalClient({
      fetch: binding.fetch.bind(binding),
      platformSecret: secret,
    });
  }
  return out;
}

/** The coordinator is stateless — rebuilt per request; durable state is in the DOs. */
function hostFor(env: Env): CloudflareScopeHost {
  return new CloudflareScopeHost({ scope: env.SCOPE, controlPlane: env.CONTROL_PLANE });
}

/**
 * Staff session (OIDC, gated by the roster) when the roster D1 is bound, plus the
 * UNSAFE dev-actor header when explicitly enabled (local/test only). Session first;
 * neither → 401. Secure by default: a real deploy binds AUTH_DB and never sets
 * ALLOW_DEV_ACTOR.
 */
function authFor(env: Env): PlatformActorAuth {
  const readers: PlatformActorAuth[] = [];
  // Staff sign in: an OIDC session (AuthHero), gated by the D1 roster.
  if (env.AUTH_DB) {
    // The roster is DATA, not config (#42): one actor per human, revocable by a
    // timestamp rather than by editing a secret. migrations/0002_staff_roster.sql.
    readers.push(sessionPlatformAuth(oidcStaffSessionReader(env), d1StaffRoster(env.AUTH_DB)));
  }
  // A connected vertical registers as a service (shared token), not staff.
  if (env.SERVICE_TOKEN) readers.push(serviceTokenAuth(env.SERVICE_TOKEN, SERVICE_ACTOR));
  // Local dev / test only.
  if (env.ALLOW_DEV_ACTOR === 'true') readers.push(UNSAFE_devPlatformActorAuth());
  return firstPlatformActorAuth(...readers);
}

export default {
  fetch(request: Request, env: Env): Response | Promise<Response> {
    const app = new Hono<{ Bindings: Env }>();

    // Staff sign-in: OIDC relying party (AuthHero) — /api/auth/login → /callback →
    // /logout. Same-origin with the console, so the session cookie just carries.
    // Registered before the /api router so these paths win over it.
    mountOidcRoutes(app);

    // Who is signed in — the console SPA polls this (null when there is no session).
    app.get('/api/auth/session', async (c) => {
      const staff = await oidcStaffSessionReader(c.env)(c.req.raw.headers);
      return c.json({ user: staff ? { email: staff.email } : null });
    });

    // The audited control-plane API under /api (the console's baseUrl).
    app.route(
      '/api',
      createControlPlaneApi({
        host: hostFor(env),
        authenticate: authFor(env),
        verticals: verticalsFor(env),
        resolveVertical: resolveVerticalFor(env),
        deployVertical: deployVerticalFor(env),
      }),
    );

    // The console SPA for everything else; the assets binding does the SPA fallback.
    if (env.ASSETS) {
      const assets = env.ASSETS;
      app.all('*', () => assets.fetch(request));
    }

    return app.fetch(request, env);
  },
};
