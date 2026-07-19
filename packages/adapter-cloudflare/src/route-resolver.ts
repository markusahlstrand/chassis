import { routeTarget, type RouteTarget } from '@substrat-run/contracts';

/**
 * Hostname → route target, for the router worker (K-26).
 *
 * Deliberately NOT `CloudflareScopeHost`. That coordinator needs a `SCOPE`
 * namespace binding because it can open scope DOs, and the router has no business
 * doing that — it resolves a name and forwards. Handing it the full host would give
 * it authority over every tenant's data to save one file.
 *
 * So this is the whole surface: one directory read, and no way to reach a scope.
 * The router's wrangler config binds `CONTROL_PLANE` and nothing else, which makes
 * that boundary a deployment fact rather than a convention.
 */

/** The one method this needs from the control-plane DO. */
interface HostnameReader {
  readHostname(hostname: string): Promise<{
    tenant_id: string;
    scope_id: string;
    vertical_slug: string | null;
    surface: string;
    region: string | null;
    status: string;
  } | undefined>;
}

export type RouteResolver = (hostname: string) => Promise<RouteTarget | undefined>;

/** A hostname row → what the router dispatches on. Shared with `CloudflareScopeHost`
 * so the two cannot drift on what "resolvable" means. */
export function toRouteTarget(
  row:
    | {
        tenant_id: string;
        scope_id: string;
        vertical_slug: string | null;
        surface: string;
        region: string | null;
        status: string;
      }
    | undefined,
): RouteTarget | undefined {
  if (!row || row.status !== 'active') return undefined;
  return routeTarget.parse({
    tenantId: row.tenant_id,
    scopeId: row.scope_id,
    verticalSlug: row.vertical_slug,
    surface: row.surface,
    region: row.region,
  });
}

/** DNS is case-insensitive, so the map is normalized and lookups must match. */
export const normalizeHostname = (hostname: string): string => hostname.toLowerCase();

/**
 * A resolver over the control-plane directory.
 *
 * No actor and no audit entry: this runs once per request, the same machine-path
 * carve-out `resolveIdentity` has (K-24). Only `active` bindings resolve, so a
 * hostname still validating DNS or one whose certificate failed is simply unknown.
 *
 * It does **not** re-check tenant suspension. `getScope` owns that, inside the
 * vertical, and a second enforcement point is a second thing that can disagree with
 * the first. The router's job is to find the door, not to decide who may open it.
 *
 * Uncached, per request, on purpose: K-26 defers cache invalidation to open
 * question 5 rather than answering it twice, because a cached route that keeps
 * serving a suspended tenant blunts suspension — which §7 calls a live weapon.
 */
export function createRouteResolver(controlPlane: DurableObjectNamespace): RouteResolver {
  const cp = controlPlane.get(
    controlPlane.idFromName('control-plane'),
  ) as unknown as HostnameReader;

  return async (hostname: string) => toRouteTarget(await cp.readHostname(normalizeHostname(hostname)));
}
