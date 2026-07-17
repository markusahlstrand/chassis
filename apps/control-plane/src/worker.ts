/**
 * The shared control plane as a deployable Cloudflare Worker (first-flow §4, slice 1).
 *
 * This is the *directory-side* control plane (control-plane.md §4): the tenant
 * registry, scope lifecycle, entitlements, roles, and the admin audit log — one
 * singleton `ControlPlaneDO` backed by its own SQLite, fronted by the audited
 * `createControlPlaneApi` router. It is the one deployment the whole platform
 * shares: every vertical registers its tenant/scope here, and the console reads
 * and acts through this same worker. Nothing domain-shaped runs here.
 *
 * Why a `ScopeDO` is bound at all: `CloudflareScopeHost.provisionScope` still
 * instantiates and migrates a scope's DO (host.ts), so the coordinator is only
 * constructible with a `SCOPE` namespace. This one carries **no modules** — it
 * is a placeholder that applies zero migrations and serves no operation. The
 * real scope DO (kernel + engines + the vertical's module) lives in the
 * *vertical's* deployment, keyed by the same scope id. Reconciling those two —
 * deciding that registration writes the directory record here without spinning a
 * scope DO here — is slice 4 (first-flow §6, open decision 3). Until then the
 * coupling is inherited, not endorsed.
 *
 * Local run:  pnpm --filter @substrat-run/control-plane dev   (wrangler dev, no account)
 * Deploy:     pnpm --filter @substrat-run/control-plane deploy (Workers Paid — DO SQLite)
 */
import {
  CloudflareScopeHost,
  ControlPlaneDO,
  defineScopeDO,
} from '@substrat-run/adapter-cloudflare';
import {
  createControlPlaneApi,
  UNSAFE_devPlatformActorAuth,
  type PlatformActorAuth,
} from '@substrat-run/control-plane-api';

/** The placeholder scope-DO class (see the file header): kernel only, no modules. */
export const ScopeDO = defineScopeDO([], {});
export { ControlPlaneDO };

interface Env {
  SCOPE: DurableObjectNamespace;
  CONTROL_PLANE: DurableObjectNamespace;
  /**
   * Local dev / test only: when 'true', trust the `x-platform-actor` header via
   * the UNSAFE dev stub. NEVER set on a real deploy — this header names a subject
   * with reach across every tenant on the platform (control-plane.md §6).
   */
  ALLOW_DEV_ACTOR?: string;
}

/**
 * Secure by default. Real platform-staff auth (SSO/MFA, short sessions) is
 * slice 3; until it lands, a deployed control plane fails **every** request
 * closed. The UNSAFE dev-actor stub is mounted only when `ALLOW_DEV_ACTOR` is
 * set — which happens under `wrangler dev` and in the workerd test, never on a
 * production deploy. This is the demo's `ALLOW_DEV_HEADER` posture applied to a
 * surface with cross-tenant reach: an unsafe default that must be typed out gets
 * noticed; one that is merely documented gets shipped.
 */
function authenticateFor(env: Env): PlatformActorAuth {
  if (env.ALLOW_DEV_ACTOR === 'true') return UNSAFE_devPlatformActorAuth();
  return () => null;
}

/** The coordinator is stateless — rebuilt per request; durable state is in the DOs. */
function hostFor(env: Env): CloudflareScopeHost {
  // No `registerModule`: the control plane serves the directory, never invokes a
  // scope operation, so it needs none of the code-time operation bookkeeping.
  return new CloudflareScopeHost({ scope: env.SCOPE, controlPlane: env.CONTROL_PLANE });
}

export default {
  fetch(request: Request, env: Env): Response | Promise<Response> {
    const app = createControlPlaneApi({
      host: hostFor(env),
      authenticate: authenticateFor(env),
    });
    return app.fetch(request, env);
  },
};
