import type { Scope } from '@substrat-run/contracts';

/**
 * The URL of a scope's own vertical portal (its tenant-facing dashboard/app), or
 * null when none is configured — in which case the console shows no link, the
 * same honesty rule the planned nav items follow (ConsoleShell).
 *
 * This is a DEV STAND-IN for the real thing: the `hostname → (tenant, scope,
 * vertical)` router (control-plane.md §4.2/§5.5, the "Domains" capability that is
 * not built yet). Until that exists there is no authoritative per-scope origin,
 * so locally we read a single base from `VITE_PORTAL_BASE` (the root `pnpm dev`
 * points it at the ServiceCo app) and carry the tenant/scope as query params so a
 * vertical that wants to deep-link can. When the directory can answer "where does
 * this scope live", this function reads that instead of an env var.
 */
export function portalUrl(scope: Scope): string | null {
  const base = import.meta.env.VITE_PORTAL_BASE as string | undefined;
  if (!base) return null;
  const url = new URL(base);
  url.searchParams.set('tenant', scope.tenantId);
  url.searchParams.set('scope', scope.id);
  return url.toString();
}
